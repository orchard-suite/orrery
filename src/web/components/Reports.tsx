// The reports page: what the reader's teams published, newest first, each
// one click from its newest edition. A report's record, its schedule, and its
// layout stand behind the edition, never in front of it. Whoever may make a
// report starts one here.

import { Plus } from 'lucide-react'
import { useState } from 'react'
import type { ReportLine } from '../../shared/api.ts'
import { REPORT_BLUEPRINT } from '../../shared/model.ts'
import { changeOf, formatNumber } from '../../shared/report.ts'
import { useReports, useWhoAmI } from '../api.ts'
import { ago } from '../format.ts'
import { levelOf, nextOf } from '../report.ts'
import { ReportCompose } from './ReportCompose.tsx'
import { Empty, ErrorNote, Kicker, Lamp, Link, Panel } from './ui.tsx'

/** How many of the newest editions are shown as cards. */
const CARDS = 6

export function ReportsPage() {
  const list = useReports()
  const me = useWhoAmI()
  const [making, setMaking] = useState(false)
  const person = me.data?.identity.kind === 'user'
  if (list.error) return <div className="py-6"><ErrorNote error={list.error} /></div>
  if (!list.data) return <p className="py-6 text-sm text-ink-400">Loading…</p>
  const { reports, total } = list.data
  const latest = reports.filter((r) => r.latest).slice(0, CARDS)
  const yours = reports.filter((r) => r.yours)
  const rest = reports.filter((r) => !r.yours)
  return (
    <div className="space-y-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-50">Reports</h1>
          <p className="text-[13px] text-ink-300">What your teams published, newest first.</p>
        </div>
        {person && (
          <button type="button" className="btn btn-solid" onClick={() => setMaking(true)}>
            <Plus aria-hidden className="size-4" /> New report
          </button>
        )}
      </header>
      {!reports.length && <Empty>No report yet. A report puts saved queries in order, says what changed, and arrives on a schedule.</Empty>}
      {latest.length > 0 && (
        <section aria-label="Latest editions">
          <Kicker>Latest</Kicker>
          <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
            {latest.map((r) => (
              <li key={r.key}>
                <Card report={r} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {yours.length > 0 && <Rows title="Yours" reports={yours} />}
      {rest.length > 0 && <Rows title={yours.length ? 'Others you can read' : 'All reports'} reports={rest} />}
      {total > reports.length && <p className="text-[12px] text-ink-400">{reports.length} of {total.toLocaleString('en-US')} reports. Find the rest in the catalog, under Report.</p>}
      {making && <ReportCompose onClose={() => setMaking(false)} />}
    </div>
  )
}

/** A report's newest edition as a card: its headline numbers with how each moved, and what it said. */
function Card({ report }: { report: ReportLine }) {
  const latest = report.latest!
  return (
    <Link to={{ page: 'report', key: report.key }} className="flex h-full flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/70 p-3 hover:border-ink-500">
      <span>
        <span className="block text-[14px] font-semibold break-words text-ink-50">{report.title}</span>
        <span className="block text-[12px] text-ink-400">
          {report.home ? `${report.home.title} · ` : ''}Edition {latest.number} · {ago(latest.publishedAt)}
        </span>
      </span>
      {latest.stats.length > 0 && (
        <span className="flex flex-wrap gap-x-5 gap-y-2">
          {latest.stats.map((s) => {
            const change = changeOf(s)
            return (
              <span key={s.name} className="min-w-0">
                <span className="block text-[18px] font-semibold text-ink-50 tabular-nums">{formatNumber(s.value, s.decimals, s.unit)}</span>
                <span className="block text-[12px] text-ink-300">{s.title}</span>
                {change && <span className={`block text-[12px] ${change.tone === 'good' ? 'text-green' : change.tone === 'bad' ? 'text-red' : 'text-ink-400'}`}>{change.text}</span>}
              </span>
            )
          })}
        </span>
      )}
      <span className="line-clamp-3 border-l-2 border-edge pl-2 text-[13px] text-ink-200">{latest.summary}</span>
    </Link>
  )
}

function Rows({ title, reports }: { title: string; reports: ReportLine[] }) {
  return (
    <section aria-label={title}>
      <Kicker>{title}</Kicker>
      <Panel className="mt-2 divide-y divide-ink-700">
        {reports.map((r) => (
          <div key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
            <Lamp level={levelOf(r.status)} title={r.statusReason ?? undefined} />
            <div className="min-w-0 flex-1 basis-56">
              <Link to={{ page: 'report', key: r.key }} className="text-[14px] font-medium break-words text-ink-50 hover:underline">{r.title}</Link>
              <p className="text-[12px] text-ink-400">
                {r.home ? `${r.home.title} · ` : ''}
                {r.latest ? `Edition ${r.latest.number}, ${ago(r.latest.publishedAt)}` : 'Never published'}
              </p>
            </div>
            <p className="text-[12px] text-ink-300">{nextOf(r)}</p>
            <Link to={{ page: 'entity', blueprint: REPORT_BLUEPRINT, key: r.key }} className="text-[13px] text-ink-300 hover:text-ink-100 hover:underline">Settings</Link>
          </div>
        ))}
      </Panel>
    </section>
  )
}
