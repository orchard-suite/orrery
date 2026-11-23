// Self-service insights: what the actions are used for and what they cost the
// platform, over a window. Which actions run most and which nobody runs, who
// runs them, how often people batch and how big and long their batches are,
// and each runner hour by hour: how busy it is, how long runs wait for it,
// and what approved schedules add, to size what runs it.

import { useState } from 'react'
import { useActionInsights, useHolds } from '../api.ts'
import { ago, duration } from '../format.ts'
import { HourBars } from './Schedules.tsx'
import { Empty, ErrorNote, Kicker, Link, Panel, input } from './ui.tsx'
import { useVisit } from '../trail.ts'

const WINDOWS = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' } as const

const secs = (s: number | null) => (s === null ? '' : duration(s * 1000))
const n = (x: number) => x.toLocaleString('en-US')
const perDay = (runs: number) => `${n(runs)} ${runs === 1 ? 'run' : 'runs'} a day`

export function InsightsPage() {
  const allowed = useHolds('audit.view')
  const [days, setDays] = useVisit<keyof typeof WINDOWS>('insights.days', 30)
  const data = useActionInsights(days, allowed)
  if (!allowed) return <Empty>Self-service insights need the "audit.view" permission: they say who ran what.</Empty>
  const d = data.data
  const offset = -new Date().getTimezoneOffset() / 60
  const local = (utc: number[]) => utc.map((_, h) => utc[(((h - offset) % 24) + 24) % 24]!)
  return (
    <div className="space-y-5 py-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <Kicker>
          <Link to={{ page: 'actions', id: null }} className="hover:underline">
            Self-service
          </Link>
        </Kicker>
        <h1 className="page-title basis-full md:basis-auto">Insights</h1>
        <select className={`${input} ml-auto`} aria-label="Window" value={days} onChange={(e) => setDays(Number(e.target.value) as keyof typeof WINDOWS)}>
          {Object.entries(WINDOWS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={data.error} />
      {d && (
        <>
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-ink-100">Runners, hour by hour</h2>
            <p className="text-[12px] text-ink-400">Runner-minutes on an average day of the window, in your time. The amber line is what approved schedules add. A runner's width is how many runs it takes at once.</p>
            {d.runners.length === 0 && <Empty>No runner ran anything in this window.</Empty>}
            {d.runners.map((r) => {
              const waits = r.waitSeconds.filter((w): w is number => w !== null)
              const worst = waits.length ? Math.max(...waits) : null
              return (
                <Panel key={r.runner} className="space-y-1 px-4 py-3">
                  <HourBars label={`${r.runner}${r.width ? ` · runs ${r.width} at once` : ''}`} values={local(r.busySeconds).map((s) => s / 60)} overlay={local(r.scheduledSeconds).map((s) => s / 60)} unit="min" />
                  <p className="text-[12px] text-ink-400">
                    {perDay(Math.round(r.runs.reduce((a, b) => a + b, 0)))}
                    {worst !== null ? ` · runs wait up to ${secs(worst)} for it in its busiest hour` : ''}
                    {r.width ? ` · busiest hour ${Math.round((Math.max(...r.busySeconds) / (r.width * 3600)) * 100)}% full` : ''}
                  </p>
                </Panel>
              )
            })}
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold text-ink-100">Actions</h2>
            <Panel className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[11px] tracking-wide text-ink-400 uppercase">
                  <tr>
                    {['Action', 'Runs', 'People', 'Failed', 'Retried', 'In batches', 'Scheduled', 'Typical', 'Slowest 5%', 'Last run'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {d.actions.map((a) => (
                    <tr key={a.action} className={a.runs === 0 ? 'text-ink-500' : 'text-ink-200'}>
                      <td className="px-3 py-1.5">
                        <Link to={{ page: 'actions', id: a.action }} className="hover:underline">
                          {a.title}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">{n(a.runs)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{n(a.people)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{a.runs ? `${Math.round((a.failed / a.runs) * 100)}%` : ''}</td>
                      <td className="px-3 py-1.5 tabular-nums">{a.retried ? n(a.retried) : ''}</td>
                      <td className="px-3 py-1.5 tabular-nums">{a.batched ? n(a.batched) : ''}</td>
                      <td className="px-3 py-1.5 tabular-nums">{a.scheduled ? n(a.scheduled) : ''}</td>
                      <td className="px-3 py-1.5 tabular-nums">{secs(a.meanSeconds)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{secs(a.p95Seconds)}</td>
                      <td className="px-3 py-1.5">{a.lastRunAt ? ago(a.lastRunAt) : 'never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <p className="text-[12px] text-ink-400">Greyed out: no runs in this window. Last run is their newest ever, so an action nobody uses shows how long it has been.</p>
          </section>

          <div className="grid gap-5 md:grid-cols-2">
            <section className="space-y-2">
              <h2 className="text-base font-semibold text-ink-100">Batches</h2>
              {d.batches.length === 0 ? (
                <Empty>No batches in this window.</Empty>
              ) : (
                <Panel className="divide-y divide-ink-800">
                  {d.batches.map((b) => (
                    <div key={b.action} className="px-4 py-2 text-[13px] text-ink-200">
                      <span className="font-medium text-ink-50">{d.actions.find((a) => a.action === b.action)?.title ?? b.action}</span>: {n(b.batches)} {b.batches === 1 ? 'batch' : 'batches'}
                      {b.scheduled ? ` (${n(b.scheduled)} scheduled)` : ''}, {n(Math.round(b.meanSize))} things each on average, {n(b.largest)} at most{b.meanSeconds !== null ? `, ${secs(b.meanSeconds)} each` : ''}
                    </div>
                  ))}
                </Panel>
              )}
            </section>
            <section className="space-y-2">
              <h2 className="text-base font-semibold text-ink-100">Who runs the most</h2>
              {d.people.length === 0 ? (
                <Empty>Nobody ran anything in this window.</Empty>
              ) : (
                <Panel className="divide-y divide-ink-800">
                  {d.people.map((p) => (
                    <div key={p.person} className="flex gap-3 px-4 py-2 text-[13px] text-ink-200">
                      <span className="min-w-0 flex-1 truncate">{p.person}</span>
                      <span className="tabular-nums">
                        {n(p.runs)} runs · {n(p.actions)} {p.actions === 1 ? 'action' : 'actions'}
                        {p.batches ? ` · ${n(p.batches)} batches` : ''}
                      </span>
                    </div>
                  ))}
                </Panel>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
