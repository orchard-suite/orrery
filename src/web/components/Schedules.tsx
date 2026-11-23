// Schedules: self-service actions run later, as the person who set them up:
// once at a moment, a run put off, or on a cadence once someone who decides
// approvals approves it. The drawer sets one up from any form that runs an
// action, alone or on many, with what that form asked. The card
// shows one where a decision on it waits, and the controls are what may be
// done with one, wherever it is shown. The page of them is `SchedulesPage.tsx`.

import { CalendarClock, Clock, Pause, Play, Repeat, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ActionSchedule, ScheduleRequest } from '../../shared/api.ts'
import { HOUR_STEPS, WEEKDAYS, cadenceProblem, cadenceWords, isOnce, shortestGapMs, type Cadence, type Repeating, type Weekday } from '../../shared/cadence.ts'
import { inputEmpty } from '../../shared/input-kinds.ts'
import { roughly } from '../../shared/estimate.ts'
import { DEFAULT_TELL, SCHEDULE_TELLS, TELL_WORDS, firesTheSame, type ScheduleTell } from '../../shared/schedule.ts'
import { parseDuration } from '../../shared/model.ts'
import { useActions, useAskSchedule, useScheduleControl } from '../api.ts'
import { navigate } from '../router.ts'
import { useChanged } from '../layers.ts'
import { Drawer } from './Drawer.tsx'
import { inputShown } from '../actions.ts'
import { fromLocalInput, laterChoices, localInput, minutesADay, onceAt } from '../schedules.ts'
import { Badge, Button, ErrorNote, Link, Panel, input } from './ui.tsx'

/** The time zone the browser keeps: where most people mean "6 in the morning". */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** When a run put off starts as: the first moment offered, an hour from now, where the person is. */
export function startCadence(): Cadence {
  return onceAt(laterChoices(new Date())[0]!.at, localZone())
}

/** A cadence that repeats to start from: every day at the time of day the moment picked so far names, else six in the morning. */
function startRepeat(from: Cadence): Repeating {
  if (from.every !== 'once') return from
  const at = new Date(from.on)
  return { every: 'day', at: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, tz: from.tz }
}

/**
 * Runs an action later, or changes when: once at a moment, a run put off,
 * which fires then as if the person ran it then; or again and again on a
 * cadence, which someone who decides approvals approves first. Its name and
 * who else hears of each result are asked too. What it runs, with what, and
 * on what come from the form it was opened from. An action that does not
 * allow schedules may still be put off once.
 */
export function ScheduleDrawer({ request, id = null, onClose }: { request: ScheduleRequest; id?: string | null; onClose: () => void }) {
  const [title, setTitle] = useState(request.title)
  const [cadence, setCadence] = useState<Cadence>(request.cadence)
  // What each way was set to, so a switch back keeps it.
  const [kept, setKept] = useState<{ once: Cadence; repeat: Repeating }>(() => ({ once: isOnce(request.cadence) ? request.cadence : startCadence(), repeat: startRepeat(request.cadence) }))
  const [deliver, setDeliver] = useState((request.deliver ?? []).join(', '))
  const [tell, setTell] = useState<ScheduleTell>(request.tell ?? DEFAULT_TELL)
  const changed = useChanged([title, cadence, deliver, tell])
  const ask = useAskSchedule()
  const action = useActions().data?.actions.find((a) => a.id === request.action)
  const repeats = !!action?.schedule
  const once = isOnce(cadence)
  const minMs = action?.schedule ? parseDuration(action.schedule.min) : 0
  const tooSoon = cadence.every === 'once' && Date.parse(cadence.on) <= Date.now() + 60_000
  const problem = cadenceProblem(cadence) ?? (tooSoon ? 'Pick a moment still to come' : null) ?? (!once && shortestGapMs(cadence) < minMs ? `"${action?.title}" runs at most once every ${action?.schedule?.min}` : null)
  const people = deliver
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const asks = action ? Object.entries(request.inputs).flatMap(([n, v]) => (!action.inputs[n] || inputEmpty(action.inputs[n]!, v) ? [] : [`${action.inputs[n]!.title ?? n}: ${inputShown(action.inputs[n], v)}`])) : []
  const switchTo = (way: 'once' | 'repeat') => {
    if (way === (once ? 'once' : 'repeat')) return
    const now = once ? { ...kept, once: cadence } : { ...kept, repeat: cadence as Repeating }
    setKept(now)
    setCadence(way === 'once' ? now.once : now.repeat)
  }
  // A change to its name or who hears keeps an approved schedule as it stands; only one that fires differently is asked again.
  const asksAgain = !once && (!id || !firesTheSame(request, { ...request, cadence }))
  const send = () => ask.mutate({ id, request: { ...request, title: title.trim(), cadence, deliver: people, tell } }, { onSuccess: (s) => (onClose(), navigate({ page: 'action-schedules', id: s.id })) })
  const moment = cadence.every === 'once' ? new Date(cadence.on) : null
  return (
    <Drawer title={id ? 'Change the schedule' : 'Run it later'} subtitle={<p>It runs as you{asks.length ? ', with what you filled in' : ''}{request.target.entities ? `, on the ${request.target.entities.length.toLocaleString('en-US')} picked` : ''}.</p>} icon={<CalendarClock className="size-6" />} onClose={onClose} unsaved={changed}>
      <form
        className="space-y-5 px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          // The drawer is drawn from inside the form that opened it: its submit stops here, or that form would run the action now as well.
          e.stopPropagation()
          send()
        }}
      >
        <div role="group" aria-label="How often" className="grid grid-cols-2 gap-2">
          {(
            [
              ['once', 'Once', 'At a moment you pick. Nobody approves it first.'],
              ['repeat', 'On repeat', repeats ? 'Again and again. Someone who decides approvals approves it first.' : `"${action?.title ?? 'This action'}" does not repeat on a schedule.`],
            ] as const
          ).map(([way, label, note]) => {
            const on = way === (once ? 'once' : 'repeat')
            return (
              <button key={way} type="button" aria-pressed={on} disabled={way === 'repeat' && !repeats} onClick={() => switchTo(way)} className={`rounded-lg border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-70 ${on ? 'border-orbit bg-ink-800' : 'border-ink-700 hover:border-ink-500'}`}>
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink-50">
                  {way === 'once' ? <Clock aria-hidden className="size-3.5" /> : <Repeat aria-hidden className="size-3.5" />}
                  {label}
                </span>
                <span className="mt-0.5 block text-[12px] text-ink-400">{note}</span>
              </button>
            )
          })}
        </div>
        {cadence.every === 'once' ? (
          <fieldset className="space-y-2 text-sm">
            <legend className="text-ink-200">When</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Soon">
              {laterChoices(new Date()).map((c) => {
                const on = moment !== null && Math.abs(moment.getTime() - c.at.getTime()) < 60_000
                return (
                  <button key={c.label} type="button" aria-pressed={on} onClick={() => setCadence(onceAt(c.at, cadence.tz))} className={`min-h-7 rounded-full border px-3 py-1 text-[13px] ${on ? 'border-ink-300 bg-ink-800 text-ink-50' : 'border-ink-700 text-ink-300 hover:text-ink-100'}`}>
                    {c.label}
                  </button>
                )
              })}
            </div>
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-ink-300">or at</span>
              <input
                className={input}
                type="datetime-local"
                aria-label="Date and time"
                min={localInput(new Date())}
                value={moment ? localInput(moment) : ''}
                onChange={(e) => {
                  const at = fromLocalInput(e.target.value)
                  if (at) setCadence(onceAt(at, cadence.tz))
                }}
              />
              <span className="text-[12px] text-ink-400">your time ({cadence.tz})</span>
            </label>
          </fieldset>
        ) : (
          <CadencePicker value={cadence} onChange={setCadence} minMs={minMs} />
        )}
        <label className="block space-y-1 text-sm">
          <span className="text-ink-200">Name</span>
          <input className={`${input} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
        </label>
        <fieldset className="space-y-2 text-sm">
          <legend className="text-ink-200">Tell me</legend>
          <div role="group" aria-label="Tell me" className="grid gap-2 sm:grid-cols-3">
            {SCHEDULE_TELLS.map((way) => {
              const on = way === tell
              return (
                <button key={way} type="button" aria-pressed={on} onClick={() => setTell(way)} className={`rounded-lg border px-3 py-2 text-left ${on ? 'border-orbit bg-ink-800' : 'border-ink-700 hover:border-ink-500'}`}>
                  <span className="block text-[13px] font-medium text-ink-50">{TELL_WORDS[way].label}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-400">{TELL_WORDS[way].note}</span>
                </button>
              )
            })}
          </div>
          <span className="block text-[12px] text-ink-400">If it cannot run at all, or it stops, you always hear.</span>
        </fieldset>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-200">Also tell</span>
          <input className={`${input} w-full`} placeholder="name@example.com, …" value={deliver} onChange={(e) => setDeliver(e.target.value)} />
          <span className="block text-[12px] text-ink-400">They hear what you hear. Name them by email.</span>
        </label>
        {asks.length > 0 && <p className="text-[13px] text-ink-300">With {asks.join(' · ')}</p>}
        <ErrorNote error={ask.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="solid" type="submit" disabled={!!problem || !title.trim() || ask.isPending}>
            {ask.isPending ? 'Saving…' : moment ? `Run it ${moment.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : !asksAgain ? 'Save' : id ? 'Ask for approval again' : 'Ask for approval'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
        {problem ? <p className="text-[12px] text-amber">{problem}</p> : <p className="text-[12px] text-ink-400">It {once ? 'runs' : 'fires'} {cadenceWords(cadence)}.{once ? ' You can change it or run it sooner from Schedules until then.' : ''}</p>}
      </form>
    </Drawer>
  )
}

const DAY_SHORT: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }

/** How often, as one choice: every hour, every few hours, every day, or some days of the week. */
type Often = 'hour' | `hours-${number}` | 'day' | 'week'

function oftenOf(c: Repeating): Often {
  return c.every === 'hours' ? `hours-${c.hours}` : c.every
}

/** The cadence a choice of how often starts as, keeping the time and zone already picked. */
function cadenceFor(often: Often, from: Repeating): Repeating {
  const at = from.every === 'hour' ? `00:${String(from.minute).padStart(2, '0')}` : from.at
  const tz = from.tz
  if (often === 'hour') return { every: 'hour', minute: from.every === 'hour' ? from.minute : Number(at.slice(3)), tz }
  if (often === 'day') return { every: 'day', at, tz }
  if (often === 'week') return { every: 'week', days: from.every === 'week' ? from.days : ['mon'], at, tz }
  return { every: 'hours', hours: Number(often.slice('hours-'.length)), at, tz }
}

/** Every hour, every few hours, every day, or some days of the week, at a time, in a time zone. Nothing tighter than `minMs` is offered. */
function CadencePicker({ value, onChange, minMs }: { value: Repeating; onChange: (c: Repeating) => void; minMs: number }) {
  const choices: { often: Often; label: string; gapMs: number }[] = [
    { often: 'hour', label: 'Every hour', gapMs: 3_600_000 },
    ...HOUR_STEPS.map((h) => ({ often: `hours-${h}` as Often, label: `Every ${h} hours`, gapMs: h * 3_600_000 })),
    { often: 'day', label: 'Every day', gapMs: 86_400_000 },
    { often: 'week', label: 'On some days', gapMs: 0 },
  ]
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="text-ink-200">When</legend>
      <div className="flex flex-wrap items-center gap-2">
        <select className={input} aria-label="How often" value={oftenOf(value)} onChange={(e) => onChange(cadenceFor(e.target.value as Often, value))}>
          {choices.map((c) => (
            <option key={c.often} value={c.often} disabled={c.gapMs > 0 && c.gapMs < minMs}>
              {c.label}
            </option>
          ))}
        </select>
        {value.every === 'hour' ? (
          <label className="flex items-center gap-1.5">
            at
            <input className={`${input} w-16`} type="number" min={0} max={59} aria-label="Minutes past the hour" value={value.minute} onChange={(e) => onChange({ ...value, minute: Number(e.target.value) })} />
            past
          </label>
        ) : (
          <label className="flex items-center gap-1.5">
            {value.every === 'hours' ? 'from' : 'at'}
            <input className={input} type="time" aria-label={value.every === 'hours' ? 'First time of the day' : 'Time'} value={value.at} onChange={(e) => onChange({ ...value, at: e.target.value })} />
          </label>
        )}
        <label className="flex items-center gap-1.5">
          in
          <input className={`${input} w-48`} aria-label="Time zone" value={value.tz} onChange={(e) => onChange({ ...value, tz: e.target.value })} />
        </label>
      </div>
      {value.every === 'week' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {WEEKDAYS.map((d) => {
            const on = value.days.includes(d)
            return (
              <button key={d} type="button" aria-pressed={on} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${on ? 'border-ink-300 bg-ink-800 text-ink-50' : 'border-ink-700 text-ink-400'}`} onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}>
                {DAY_SHORT[d]}
              </button>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

export const STATE_TONE: Record<ActionSchedule['state'], string> = { awaiting: 'border-amber/60 text-amber', active: 'border-green/50 text-green', paused: 'border-ink-600 text-ink-300', declined: 'border-red-dim text-red', done: 'border-ink-600 text-ink-300' }
export const STATE_WORD: Record<ActionSchedule['state'], string> = { awaiting: 'waits for approval', active: 'on', paused: 'paused', declined: 'declined', done: 'fired' }

/** One schedule as a card where a decision on it waits: what it runs, on what, when, as whom, the load it adds, and what the reader may do with it. */
export function ScheduleCard({ s }: { s: ActionSchedule }) {
  const actions = useActions().data?.actions ?? []
  const action = actions.find((a) => a.id === s.action)
  const load = s.load
  const minutes = minutesADay(s)
  return (
    <Panel className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={{ page: 'action-schedules', id: s.id }} className="text-sm font-medium text-ink-50 hover:underline">
          {s.title}
        </Link>
        <Badge className={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Badge>
        <span className="text-[13px] text-ink-300">
          {action?.title ?? s.action}
          {s.targetTitle ? ` on ${s.targetTitle}` : ''} · {s.when}
        </span>
        <span className="ml-auto text-[12px] text-ink-400">{s.owner}</span>
      </div>
      <p className="text-[13px] text-ink-300">
        {load ? `${load.runs.toLocaleString('en-US')} ${load.runs === 1 ? 'run' : 'runs'} each time` : 'Load not known yet'}
        {load?.estimate ? `, about ${roughly(load.estimate.seconds).replace('about ', '')} each` : ''}
        {minutes !== null ? ` · about ${Math.round(minutes).toLocaleString('en-US')} runner-minutes a day` : ''}
        {load?.runner ? ` on ${load.runner}` : ''}
      </p>
      {s.note && <p className="text-[12px] text-amber">{s.note}</p>}
      <ScheduleControls s={s} />
    </Panel>
  )
}

/** What the reader may do with one schedule: decide it, pause or resume it, fire it now, change it, or remove it. */
export function ScheduleControls({ s, onRemoved }: { s: ActionSchedule; onRemoved?: () => void }) {
  const control = useScheduleControl(s.id)
  const [editing, setEditing] = useState(false)
  const busy = Object.values(control).some((m) => m.isPending)
  const error = Object.values(control).find((m) => m.error)?.error
  // A run put off fires without anyone's approval; any other only once someone gave it.
  const fires = isOnce(s.cadence) || !!s.decidedBy
  return (
    <div className="space-y-2">
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2">
        {s.canDecide && (
          <>
            <Button kind="solid" disabled={busy} onClick={() => control.approve.mutate()}>
              Approve
            </Button>
            <Button kind="danger" disabled={busy} onClick={() => control.decline.mutate(prompt('Why decline it? The owner reads this.') ?? undefined)}>
              Decline
            </Button>
          </>
        )}
        {s.mine && s.state === 'active' && (
          <Button disabled={busy} onClick={() => control.pause.mutate()}>
            <span className="flex items-center gap-1.5">
              <Pause aria-hidden className="size-3.5" /> Pause
            </span>
          </Button>
        )}
        {s.mine && s.state === 'paused' && fires && (
          <Button disabled={busy} onClick={() => control.resume.mutate()}>
            <span className="flex items-center gap-1.5">
              <Play aria-hidden className="size-3.5" /> Resume
            </span>
          </Button>
        )}
        {s.mine && fires && (s.state === 'active' || s.state === 'paused' || s.state === 'done') && (
          <Button disabled={busy} onClick={() => confirm(s.state === 'done' ? `Run "${s.title}" again now?` : `Run "${s.title}" now?`) && control.run.mutate()}>
            {s.state === 'done' ? 'Run again now' : 'Run now'}
          </Button>
        )}
        {s.mine && (
          <Button opens="dialog" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
        {s.mine && (
          <Button kind="danger" disabled={busy} onClick={() => confirm(`Remove the schedule "${s.title}"?`) && control.remove.mutate(undefined, { onSuccess: () => onRemoved?.() })}>
            <span className="flex items-center gap-1.5">
              <Trash2 aria-hidden className="size-3.5" /> Remove
            </span>
          </Button>
        )}
      </div>
      {editing && <ScheduleDrawer id={s.id} request={{ action: s.action, title: s.title, target: s.target, inputs: s.inputs, cadence: s.cadence, deliver: s.deliver, tell: s.tell }} onClose={() => setEditing(false)} />}
    </div>
  )
}

/** Twenty-four bars, one for each hour, with the hour under every sixth. */
export function HourBars({ label, values, unit, overlay }: { label: string; values: number[]; unit: string; overlay?: number[] }) {
  const top = Math.max(1, ...values, ...(overlay ?? []))
  return (
    <figure className="space-y-1">
      <figcaption className="text-[12px] text-ink-300">{label}</figcaption>
      <div className="flex h-20 items-end gap-px rounded-sm border border-ink-800 px-1 pt-1" role="img" aria-label={`${label}: ${values.map((v, h) => `${h}:00 ${Math.round(v)} ${unit}`).join(', ')}`}>
        {values.map((v, h) => (
          <div key={h} className="relative flex h-full flex-1 items-end" title={`${String(h).padStart(2, '0')}:00 · ${Math.round(v)} ${unit}${overlay ? ` · schedules ${Math.round(overlay[h] ?? 0)} ${unit}` : ''}`}>
            <div className="w-full rounded-t-sm bg-orbit/70" style={{ height: `${(v / top) * 100}%` }} />
            {overlay && <div className="absolute bottom-0 w-full rounded-t-sm border-t-2 border-amber" style={{ height: `${((overlay[h] ?? 0) / top) * 100}%` }} />}
          </div>
        ))}
      </div>
      <div className="flex px-1 text-[10px] text-ink-500">
        {values.map((_, h) => (
          <span key={h} className="flex-1">
            {h % 6 === 0 ? `${String(h).padStart(2, '0')}` : ''}
          </span>
        ))}
      </div>
    </figure>
  )
}
