// One report: the edition picked (the newest unless the address names one, or
// the preview a run drew), drawn by the hub's one drawer; beside it the
// editions, each headline number's trend across them, and the versions of the
// layout. Picking a second edition lays the two side by side: their headline
// numbers, and each data set's rows as each kept them. Every change to a
// report is one of its actions, run from here as from its entity page.

import { useMemo } from 'react'
import type { ReportEditionRead, ReportSchedule } from '../../shared/api.ts'
import { REPORT_BLUEPRINT, type Entity } from '../../shared/model.ts'
import { formatNumber } from '../../shared/report.ts'
import { drawEdition } from '../../shared/report-draw.ts'
import { useEntity, useReport, useReportEdition, useReportPreview, useReportVersion, useRunAction } from '../api.ts'
import { ago } from '../format.ts'
import { compareEditions, nextOf, trendsOf, type ComparedData } from '../report.ts'
import { navigate } from '../router.ts'
import { useHere } from '../trail.ts'
import { EntityActions } from './ActionForm.tsx'
import { EditReport } from './ReportCompose.tsx'
import { TrendCell } from './Trend.tsx'
import { Badge, Empty, ErrorNote, Fold, Kicker, Lamp, Link, Panel } from './ui.tsx'
import { useState } from 'react'

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export function ReportPage({ reportKey, edition, compare, preview }: { reportKey: string; edition: number | null; compare: number | null; preview: string | null }) {
  const page = useReport(reportKey)
  const dressed = useEntity({ blueprint: REPORT_BLUEPRINT, key: reportKey })
  const newest = page.data?.editions[0]?.number ?? null
  const shown = preview ? null : (edition ?? newest)
  const one = useReportEdition(reportKey, shown)
  const two = useReportEdition(reportKey, compare)
  const drawn = useReportPreview(reportKey, preview)
  useHere(page.data?.report.title)
  if (page.error) return <div className="py-6"><ErrorNote error={page.error} /></div>
  if (!page.data) return <p className="py-6 text-sm text-ink-400">Loading…</p>
  const { report, editions, versions, stats, canChange, schedules } = page.data
  const go = (to: { edition?: number | null; compare?: number | null }) => navigate({ page: 'report', key: reportKey, ...(to.edition ? { edition: to.edition } : {}), ...(to.compare ? { compare: to.compare } : {}) }, { replace: true })
  const reading = preview ? drawn.data : one.data
  return (
    <div className="grid gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Head report={report} actionsOn={dressed.data ?? null} canChange={canChange} schedules={schedules ?? []} />
        {preview && <Panel className="border-orbit/60 p-3"><p className="text-[13px] text-ink-200">A preview from the newest data, drawn by a run and sent to nobody. <Link to={{ page: 'action-run', id: preview }} className="text-orbit hover:underline">Open the run</Link> · <button type="button" className="text-orbit hover:underline" onClick={() => navigate({ page: 'report', key: reportKey }, { replace: true })}>Back to the newest edition</button></p></Panel>}
        {compare && one.data && two.data ? (
          <Compared a={one.data} b={two.data} onClose={() => go({ edition: shown })} />
        ) : reading ? (
          <Edition read={reading} reportKey={reportKey} preview={!!preview} />
        ) : (preview ? drawn.error : one.error) ? (
          <ErrorNote error={preview ? drawn.error : one.error} />
        ) : !preview && !editions.length ? (
          <Empty>No edition yet. Publish it, or ask for a preview, from its actions above.</Empty>
        ) : (
          <p className="text-sm text-ink-400">Loading…</p>
        )}
      </div>
      <aside className="space-y-4">
        <Panel className="p-3">
          <Kicker>Editions</Kicker>
          {editions.length ? (
            <ol className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {editions.map((e) => {
                const open = !preview && e.number === shown
                const against = e.number === compare
                return (
                  <li key={e.number} className={`rounded-md px-2 py-1.5 ${open ? 'bg-ink-800' : against ? 'bg-orbit/10' : ''}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <button type="button" className="text-left text-[13px] font-medium text-ink-100 hover:underline" aria-current={open ? 'page' : undefined} onClick={() => go({ edition: e.number })}>
                        Edition {e.number}
                      </button>
                      {!preview && !open && (
                        <button type="button" className="text-[12px] text-ink-300 hover:text-ink-100" aria-pressed={against} onClick={() => go({ edition: shown, compare: against ? null : e.number })}>
                          {against ? 'Comparing' : 'Compare'}
                        </button>
                      )}
                    </div>
                    <p className="text-[12px] text-ink-400" title={when(e.publishedAt)}>{ago(e.publishedAt)}</p>
                    <p className="line-clamp-2 text-[12px] text-ink-300">{e.summary}</p>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="mt-2 text-[13px] text-ink-400">None yet.</p>
          )}
        </Panel>
        <Trends stats={stats} editions={editions} />
        <Versions reportKey={reportKey} versions={versions} current={Number(report.fields.version ?? 0)} canChange={canChange} />
      </aside>
    </div>
  )
}

function Head({ report, actionsOn, canChange, schedules }: { report: Entity; actionsOn: Entity | null; canChange: boolean; schedules: ReportSchedule[] }) {
  const home = Object.entries(report.relations).find(([name]) => name.startsWith('home_'))?.[1]?.[0]
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Lamp level={report.status.level} title={report.status.reasons[0] ?? undefined} />
        <h1 className="text-xl font-semibold text-ink-50">{report.title}</h1>
        <Badge>version {String(report.fields.version ?? '–')}</Badge>
      </div>
      <p className="text-[13px] text-ink-300">
        Owned by {String(report.fields.owner ?? 'nobody')}
        {home && (
          <>
            {' · '}
            <Link to={{ page: 'entity', blueprint: home.blueprint, key: home.key }} className="text-ink-100 hover:underline">{home.title ?? home.key}</Link>
          </>
        )}
        {' · '}
        {nextOf({ schedules })}
        {' · '}
        <Link to={{ page: 'entity', blueprint: REPORT_BLUEPRINT, key: report.key }} className="hover:underline">Settings and record</Link>
      </p>
      <div className="flex flex-wrap gap-2">
        {canChange && <EditReport report={{ key: report.key, title: report.title, layout: String(report.fields.layout ?? '') }} className="flex items-center gap-1.5 rounded-md border border-orbit/60 bg-orbit/10 px-2 py-1 text-[12px] font-medium text-ink-100 hover:bg-orbit/20" />}
        {/* The form above is how a person edits a layout; the same action stays for an agent. */}
        {actionsOn && <EntityActions entity={actionsOn} size="sm" except={['orrery_report_edit', 'orrery_report_restore']} />}
      </div>
    </header>
  )
}

/** An edition as the hub draws it: the drawer's own markup, every value in it escaped there. */
function Edition({ read, reportKey, preview }: { read: ReportEditionRead; reportKey: string; preview: boolean }) {
  const html = useMemo(() => drawEdition(read.content, 'web'), [read])
  const base = `/v1/reports/${encodeURIComponent(reportKey)}/editions/${read.content.number}`
  return (
    <Panel className="p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-ink-300">{preview ? 'Preview' : `Edition ${read.content.number}`} · {when(read.content.publishedAt)}</p>
        {!preview && (
          <p className="flex gap-3 text-[13px]">
            <a href={`${base}/body`} target="_blank" rel="noreferrer" className="text-orbit hover:underline">Open as a page to forward</a>
            <a href={`${base}/data`} className="text-orbit hover:underline">Download its data</a>
          </p>
        )}
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </Panel>
  )
}

function Trends({ stats, editions }: { stats: Parameters<typeof trendsOf>[0]; editions: Parameters<typeof trendsOf>[1] }) {
  const trends = trendsOf(stats, editions)
  if (!trends.length || editions.length < 2) return null
  return (
    <Panel className="p-3">
      <Kicker>Trends</Kicker>
      <ul className="mt-2 space-y-2">
        {trends.map(({ stat, trend }) => (
          <li key={stat.name} className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-200">{stat.title}</span>
            <TrendCell value={trend} />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Versions({ reportKey, versions, current, canChange }: { reportKey: string; versions: { version: number; note: string | null; by: string; at: string; restoredFrom: number | null }[]; current: number; canChange: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const layout = useReportVersion(reportKey, open)
  const run = useRunAction()
  return (
    <Panel className="p-3">
      <Kicker>Layout versions</Kicker>
      <ol className="mt-2 max-h-72 space-y-1 overflow-y-auto">
        {versions.map((v) => (
          <li key={v.version} className="text-[12px]">
            <button type="button" className="text-left text-ink-100 hover:underline" aria-expanded={open === v.version} onClick={() => setOpen(open === v.version ? null : v.version)}>
              Version {v.version}{v.version === current ? ' (current)' : ''}
            </button>
            <span className="text-ink-400"> · {v.by} · {ago(v.at)}</span>
            {(v.note || v.restoredFrom) && <p className="text-ink-300">{v.note ?? `put back version ${v.restoredFrom}`}</p>}
            {open === v.version && (layout.data ? <pre className="mt-1 max-h-64 overflow-auto rounded bg-ink-900 p-2 font-mono text-[11px] text-ink-200">{layout.data.layout}</pre> : <p className="text-ink-400">Loading…</p>)}
            {open === v.version && canChange && v.version !== current && (
              <button type="button" className="btn btn-ghost mt-1" disabled={run.isPending} onClick={() => run.mutate({ id: 'orrery_report_restore', entity: { blueprint: REPORT_BLUEPRINT, key: reportKey }, inputs: { version: v.version } }, { onSuccess: () => setOpen(null) })}>
                Put this version back
              </button>
            )}
            {open === v.version && run.error ? <ErrorNote error={run.error} /> : null}
          </li>
        ))}
      </ol>
    </Panel>
  )
}

/** Two editions side by side: the headline numbers, then each data set's rows as each edition kept them. */
function Compared({ a, b, onClose }: { a: ReportEditionRead; b: ReportEditionRead; onClose: () => void }) {
  const c = compareEditions(a, b)
  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink-100">Edition {c.older} beside edition {c.newer}</h2>
          <button type="button" className="text-[13px] text-orbit hover:underline" onClick={onClose}>Stop comparing</button>
        </div>
        {c.stats.length ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-ink-300">
                <th className="py-1 font-medium">Number</th>
                <th className="py-1 text-right font-medium">Edition {c.older}</th>
                <th className="py-1 text-right font-medium">Edition {c.newer}</th>
                <th className="py-1 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {c.stats.map((s) => (
                <tr key={s.name} className="border-t border-ink-700">
                  <td className="py-1 text-ink-200">{s.title}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(s.older, s.stat.decimals, s.stat.unit)}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(s.newer, s.stat.decimals, s.stat.unit)}</td>
                  <td className={`py-1 text-right ${s.change?.tone === 'good' ? 'text-green' : s.change?.tone === 'bad' ? 'text-red' : 'text-ink-300'}`}>{s.change?.text ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[13px] text-ink-400">Neither edition has headline numbers.</p>
        )}
      </Panel>
      {c.data.map((d) => (
        <Fold key={d.name} title={d.name} summary={<span className="text-ink-300">{d.older?.total ?? 0} rows, then {d.newer?.total ?? 0}</span>}>
          <div className="grid gap-3 md:grid-cols-2">
            <DataSide label={`Edition ${c.older}`} d={d} side={d.older} />
            <DataSide label={`Edition ${c.newer}`} d={d} side={d.newer} />
          </div>
        </Fold>
      ))}
    </div>
  )
}

function DataSide({ label, d, side }: { label: string; d: ComparedData; side: ComparedData['older'] }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[12px] text-ink-300">{label}</p>
      {!side ? (
        <p className="text-[12px] text-ink-400">Not read in this edition.</p>
      ) : side.error ? (
        <p className="text-[12px] text-ink-400">{side.error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr>{d.columns.map((col) => <th key={col} className="whitespace-nowrap border-b border-edge px-1.5 py-1 text-left font-medium text-ink-300">{col}</th>)}</tr>
            </thead>
            <tbody>
              {side.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="border-b border-ink-700 px-1.5 py-1 tabular-nums">{v}</td>)}</tr>)}
            </tbody>
          </table>
          {side.total > side.rows.length && <p className="mt-1 text-[12px] text-ink-400">{side.rows.length} of {side.total.toLocaleString('en-US')} rows</p>}
        </div>
      )}
    </div>
  )
}
