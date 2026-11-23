import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Budget, BudgetKind, LoadColumn, LoadHour, LoadResponse } from '../../shared/api.ts'
import { AREAS, areaTimes, budgetFor, budgetState, byFit, bySubject, bytes, columnFit, count, FIT_SAID, heldTrend, loadSignals, MONTH_DAYS, repeatsOf, said, shownShare, took, type LoadArea, type LoadSignal, type SignalGroup, type SignalLevel } from '../../shared/load-signals.ts'
import { isSpread, type Blueprint, type StatusLevel } from '../../shared/model.ts'
import { useBlueprintName, useBlueprints, useCan, useHolds, useIsAdmin, useLoad } from '../api.ts'
import { duration } from '../format.ts'
import { lockOf } from './BlueprintEditor.tsx'
import { FieldPopover } from './FieldForm.tsx'
import { BudgetsTable, rowsOf, type BudgetRow } from './LoadBudgets.tsx'
import { HeldChart, HeldSpark } from './HeldChart.tsx'
import { Button, Empty, ErrorNote, input, Lamp, Link, mono, Panel } from './ui.tsx'
import { useVisit } from '../trail.ts'

const SPANS = { 1: 'Last hour', 24: 'Last day', 168: 'Last 7 days' } as const
type Span = keyof typeof SPANS
/** How many rows a full list shows before it is asked for the rest. */
const FIRST = 12
/** How many names an area shows of its own. */
const TOP = 6
/** A link in a table row: tall and wide enough to tap. */
const TAP = 'inline-block min-w-6 py-0.5 leading-5 hover:underline'
/** How many signals worth a look show before they are asked for. */
const WATCH_FIRST = 5

/** Each area's colour: a value colour, so it never reads as a status. */
const AREA_COLOR: Record<LoadArea, string> = { in: 'var(--color-v-turquoise)', work: 'var(--color-v-purple)', out: 'var(--color-v-blue)' }
const AREA_ORDER: LoadArea[] = ['in', 'work', 'out']
/** The parts of an hour that make up each area. */
const HOUR_PARTS: Record<LoadArea, (keyof Omit<LoadHour, 'hour'>)[]> = { in: ['write'], work: ['derive', 'grids', 'relink'], out: ['read'] }

const LAMP: Record<SignalLevel, { level: StatusLevel; faint?: boolean }> = { limit: { level: 'red' }, warn: { level: 'amber' }, near: { level: 'amber', faint: true }, watch: { level: 'grey' } }
const CHIP: Record<SignalLevel, string> = {
  limit: 'bg-red/15 text-red',
  warn: 'bg-amber/15 text-amber',
  near: 'border border-dashed border-amber text-amber',
  watch: 'bg-ink-800 text-ink-200',
}
const BAR: Record<SignalLevel, string> = { limit: 'bg-red', warn: 'bg-amber', near: 'bg-amber/60', watch: 'bg-ink-300' }

function levelSaid(s: Pick<LoadSignal, 'level' | 'budget'>): string {
  if (s.level === 'limit') return 'Past its limit'
  if (s.level === 'warn') return 'Past its warning'
  if (s.level === 'near') return s.budget?.held.warn === undefined ? 'Near its limit' : 'Near its warning'
  return 'Worth a look'
}

const hourOf = (iso: string, span: Span) => new Date(iso).toLocaleString(undefined, span === 168 ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' })
const hourTotal = (h: LoadHour) => h.derive + h.grids + h.relink + h.write + h.read

/**
 * What costs the hub, said for an operator: a verdict, then what needs a
 * look, worst first, each with what is seen, why it costs, and what can be
 * done; then where the time went by area, and every list in full beneath.
 * Whoever may set the budgets sets them here, where what they hold is shown.
 */
export function Load() {
  const allowed = useHolds('audit.view')
  const [span, setSpan] = useVisit<Span>('load.span', 24)
  const load = useLoad(span, allowed)
  const name = useBlueprintName()
  const listed = useBlueprints().data
  const blueprints = listed?.blueprints
  const field = useMemo(() => {
    const of = new Map((blueprints ?? []).map((bp) => [bp.id, bp]))
    return (blueprint: string, f: string) => of.get(blueprint)?.fields[f]?.title || f
  }, [blueprints])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [draft, setDraft] = useState<BudgetRow[] | null>(null)
  const data = load.data
  const signals = useMemo(() => (data ? loadSignals(data, name, field) : []), [data, name, field])
  if (!allowed) return <Empty>The load of the hub needs the "audit.view" permission.</Empty>

  const toggle = (id: string, to?: boolean) =>
    setOpen((now) => {
      const next = new Set(now)
      if (to ?? !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })
  const reveal = (id: string) => {
    toggle(id, true)
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  /** Adds a row to the budgets for one name, at what it is held to now, and shows it. */
  const ownBudget = (kind: BudgetKind, id: string, held: Budget) => {
    if (!data) return
    const rows = draft ?? rowsOf(data.budgets)
    if (!rows.some((r) => r.kind === kind && r.name === id)) setDraft([...rows, { kind, name: id, warn: held.warn?.toString() ?? '', limit: held.limit?.toString() ?? '' }])
    reveal('load-budgets')
  }

  return (
    <div className="space-y-6 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Load</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className={input} aria-label="Window" value={span} onChange={(e) => setSpan(Number(e.target.value) as Span)}>
            {Object.entries(SPANS).map(([hours, label]) => (
              <option key={hours} value={hours}>
                {label}
              </option>
            ))}
          </select>
          <Button onClick={() => void load.refetch()} disabled={load.isFetching}>
            Refresh
          </Button>
        </div>
      </div>
      <ErrorNote error={load.error} />
      {data && (
        <>
          <Verdict data={data} signals={signals} span={span} />
          <NeedsLook groups={bySubject(signals)} name={name} ownBudget={ownBudget} budgets={data.budgets} />
          <Areas data={data} signals={signals} name={name} reveal={reveal} />
          <Fold id="load-budgets" open={open.has('load-budgets') || draft !== null} onToggle={() => toggle('load-budgets')} title="Budgets" summary={budgetSummary(data, signals)}>
            <BudgetsTable budgets={data.budgets} draft={draft} setDraft={setDraft} />
          </Fold>
          <Lists data={data} name={name} open={open} toggle={toggle} />
          <Columns columns={data.columns} blueprints={blueprints ?? []} adminOnly={listed?.adminOnly ?? []} name={name} field={field} open={open.has('load-columns')} toggle={() => toggle('load-columns')} />
          <p className="text-[13px] text-ink-400">Counts are stored once a minute, so the last minute may be missing.</p>
        </>
      )}
    </div>
  )
}

function heldSummary(data: LoadResponse): string {
  const n = data.blueprints.reduce((sum, b) => sum + b.entities, 0)
  return `${count(n)} entities in ${data.blueprints.length} ${data.blueprints.length === 1 ? 'blueprint' : 'blueprints'}`
}

function budgetSummary(data: LoadResponse, signals: LoadSignal[]): string {
  const set = Object.values(data.budgets).reduce((n, b) => n + Object.keys(b).length, 0)
  if (!set) return 'None set'
  const past = bySubject(signals).filter((g) => g.level === 'limit' || g.level === 'warn').length
  return `${set} set${past ? `; ${past} ${past === 1 ? 'name has' : 'names have'} passed one` : ''}`
}

/** The verdict in words, beside the hours it is drawn from. */
function Verdict({ data, signals, span }: { data: LoadResponse; signals: LoadSignal[]; span: Span }) {
  const groups = bySubject(signals)
  const n = (level: SignalLevel) => groups.filter((g) => g.level === level).length
  const [limit, warn, near, watch] = [n('limit'), n('warn'), n('near'), n('watch')]
  const times = areaTimes(data)
  const lead = AREA_ORDER.reduce((a, b) => (times[b] > times[a] ? b : a))
  const parts: ReactNode[] = []
  if (limit) parts.push(<span key="l" className="text-red">{limit} past a limit</span>)
  if (warn) parts.push(<span key="w" className="text-amber">{warn} past a warning</span>)
  if (near) parts.push(<span key="n">{near} near one</span>)
  const busiest = data.hourly.reduce<LoadHour | null>((a, h) => (!a || hourTotal(h) > hourTotal(a) ? h : a), null)
  const queue = data.queue.depth ? `${count(data.queue.depth)} wait to be derived, the oldest for ${duration((data.queue.oldestSeconds ?? 0) * 1000)}.` : 'Nothing waits to be derived.'
  return (
    <section className="grid items-end gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]" aria-label="Verdict">
      <div>
        <p className="font-serif text-[28px] leading-tight text-ink-50 md:text-[32px]">
          {parts.length ? parts.reduce<ReactNode[]>((all, p, i) => (i ? [...all, i === parts.length - 1 ? ' and ' : ', ', p] : [p]), []) : 'Everything is inside its budget'}
          {'. '}
          Most of the hub’s time goes to {AREAS[lead].title.toLowerCase()}.
        </p>
        <p className="mt-2 text-sm text-ink-300">
          {busiest && hourTotal(busiest) > 0 && `The busiest hour, from ${hourOf(busiest.hour, span)}, took ${took(hourTotal(busiest))} of work. `}
          {queue}
          {watch > 0 && ` ${watch} more ${watch === 1 ? 'thing is' : 'things are'} worth a look.`}
        </p>
      </div>
      <Hours hours={data.hourly} span={span} times={times} />
    </section>
  )
}

/** The hub's time hour by hour, each hour stacked by area. */
function Hours({ hours, span, times }: { hours: LoadHour[]; span: Span; times: Record<LoadArea, number> }) {
  const max = Math.max(1, ...hours.map(hourTotal))
  const every = span === 168 ? 24 : span === 24 ? 6 : 1
  const height = 88
  return (
    <figure className="m-0">
      <figcaption className="label mb-2 flex justify-between">
        <span>Hub time each hour</span>
        <span className="tabular-nums">peak {took(max)}</span>
      </figcaption>
      <div className="flex items-end gap-px border-b border-ink-700" style={{ height }} role="img" aria-label={`Hub time each hour: the busiest took ${took(max)}.`}>
        {hours.map((h) => (
          <div key={h.hour} className="flex min-w-0 flex-1 flex-col-reverse" title={`${hourOf(h.hour, span)}: ${took(hourTotal(h))}. ${AREA_ORDER.map((a) => `${AREAS[a].title} ${took(HOUR_PARTS[a].reduce((n, k) => n + h[k], 0))}`).join(', ')}`}>
            {AREA_ORDER.map((a) => {
              const ms = HOUR_PARTS[a].reduce((n, k) => n + h[k], 0)
              return ms ? <span key={a} className="block" style={{ height: (ms / max) * height, background: AREA_COLOR[a] }} /> : null
            })}
          </div>
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[12px] text-ink-400" aria-hidden>
        {hours.map((h, i) => {
          if (i % every !== 0) return null
          // The first and the last label keep inside the chart; the rest sit under their bar's middle.
          const place = i === 0 ? { left: 0 } : i === hours.length - 1 ? { right: 0 } : { left: `${((i + 0.5) / hours.length) * 100}%`, transform: 'translateX(-50%)' }
          return (
            <span key={h.hour} className="absolute top-0 whitespace-nowrap" style={place}>
              {hourOf(h.hour, span)}
            </span>
          )
        })}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-300">
        {AREA_ORDER.map((a) => (
          <li key={a} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: AREA_COLOR[a] }} aria-hidden />
            {AREAS[a].title} <span className="text-ink-400 tabular-nums">{took(times[a])}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

const subjectName = (s: LoadSignal['subject'], name: (id: string) => string) => (s.kind === 'blueprint' ? name(s.id) : s.kind === 'queue' ? 'The derive queue' : s.id)
const subjectKind: Record<LoadSignal['subject']['kind'], string> = { source: 'Source', caller: 'Caller', blueprint: 'Blueprint', queue: 'Queue' }

/** Everything worth a look, one row a subject, worst first. What passed or nears a budget opens on its own; the rest wait under it. */
function NeedsLook({ groups, name, ownBudget, budgets }: { groups: SignalGroup[]; name: (id: string) => string; ownBudget: (kind: BudgetKind, id: string, held: Budget) => void; budgets: LoadResponse['budgets'] }) {
  const urgent = groups.filter((g) => g.level !== 'watch')
  const watch = groups.filter((g) => g.level === 'watch')
  const [all, setAll] = useState(false)
  const shown = all ? watch : watch.slice(0, WATCH_FIRST)
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-800 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink-50">Needs a look</h2>
        <span className="text-[13px] text-ink-400">{groups.length ? 'Worst first. Open one to see what is happening, why it costs, and what you can do.' : 'Nothing: every budget holds, and nothing costs out of the ordinary.'}</span>
      </div>
      {urgent.map((g, i) => (
        <SignalRow key={g.key} group={g} name={name} start={i === 0 && (g.level === 'limit' || g.level === 'warn')} ownBudget={ownBudget} budgets={budgets} />
      ))}
      {watch.length > 0 && (
        <>
          <div className="border-t border-ink-800 bg-ink-850/60 px-4 py-1.5 text-[12px] font-medium text-ink-400">Worth a look: no budget counts these, but each costs more than it needs to</div>
          {shown.map((g) => (
            <SignalRow key={g.key} group={g} name={name} start={false} ownBudget={ownBudget} budgets={budgets} />
          ))}
          {watch.length > WATCH_FIRST && (
            <div className="border-t border-ink-800 px-4 py-2">
              <Button onClick={() => setAll(!all)}>{all ? `Show the first ${WATCH_FIRST}` : `Show all ${watch.length}`}</Button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

function SignalRow({ group, name, start, ownBudget, budgets }: { group: SignalGroup; name: (id: string) => string; start: boolean; ownBudget: (kind: BudgetKind, id: string, held: Budget) => void; budgets: LoadResponse['budgets'] }) {
  const [open, setOpen] = useState(start)
  const [first] = group.signals
  const s = first!
  const who = subjectName(group.subject, name)
  const body = `load-signal-${group.key}`
  return (
    <div className="border-t border-ink-800 first-of-type:border-t-0">
      <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 text-left hover:bg-ink-850 xl:grid-cols-[0.75rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(12rem,1.1fr)_10.5rem]">
        <Lamp {...LAMP[group.level]} title={levelSaid(s)} />
        <span className="min-w-0">
          <span className={`block font-medium break-words text-ink-50 ${group.subject.kind === 'source' ? mono : ''}`}>{who}</span>
          <span className="block text-[12px] text-ink-400">
            {AREAS[group.area].title} · {subjectKind[group.subject.kind]}
          </span>
        </span>
        <span className="col-span-full row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-100 xl:col-span-1 xl:row-start-auto xl:block">
          <span>
            {s.title}
            {group.signals.length > 1 && <span className="text-ink-400"> and {group.signals.length - 1} more</span>}
          </span>
          {/* On a narrow screen the level sits here, so the name keeps the first line to itself. */}
          <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap xl:hidden ${CHIP[group.level]}`}>{levelSaid(s)}</span>
        </span>
        <span className="col-span-full row-start-3 xl:col-span-1 xl:row-start-auto">
          <Measure signal={s} />
        </span>
        <span className="col-start-3 row-start-1 flex items-center justify-end gap-2 xl:col-start-auto xl:row-start-auto">
          <span className={`hidden rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap xl:inline ${CHIP[group.level]}`}>{levelSaid(s)}</span>
          {open ? <ChevronDown className="size-4 shrink-0 text-ink-400" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden />}
        </span>
      </button>
      {open && (
        <div id={body} className="space-y-4 px-4 pt-1 pb-4 xl:pl-10">
          {group.signals.map((sig, i) => (
            <div key={`${sig.title}-${i}`} className="space-y-2">
              {i > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-800 pt-3">
                  <span className="font-medium text-ink-100">{sig.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${CHIP[sig.level]}`}>{levelSaid(sig)}</span>
                  <span className="min-w-48 flex-1 md:max-w-sm">
                    <Measure signal={sig} />
                  </span>
                </div>
              )}
              <div className="grid gap-4 text-sm md:grid-cols-3">
                <div>
                  <h3 className="label mb-1">What we see</h3>
                  <p className="text-ink-100">{sig.seen}</p>
                </div>
                <div>
                  <h3 className="label mb-1">Why it costs</h3>
                  <p className="text-ink-300">{sig.why}</p>
                </div>
                <div>
                  <h3 className="label mb-1">What you can do</h3>
                  <ul className="list-disc space-y-1 pl-4 text-ink-100">
                    {sig.fixes.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
              {sig.trend && <HeldChart trend={sig.trend} budget={sig.budget?.held} label={`${who}: entities held`} />}
            </div>
          ))}
          <SignalActions group={group} ownBudget={ownBudget} budgets={budgets} />
        </div>
      )}
    </div>
  )
}

/** Where to go from a signal: what it is about, and its budget for whoever may set one. */
function SignalActions({ group, ownBudget, budgets }: { group: SignalGroup; ownBudget: (kind: BudgetKind, id: string, held: Budget) => void; budgets: LoadResponse['budgets'] }) {
  const may = useCan('budgets.set')
  const held = group.signals.find((s) => s.budget)?.budget
  const link = 'btn btn-ghost'
  const own = held && budgets[held.kind][group.subject.id] !== undefined
  return (
    <div className="flex flex-wrap gap-2">
      {group.subject.kind === 'blueprint' && (
        <Link to={{ page: 'inventory', blueprint: group.subject.id }} className={link}>
          Open the blueprint
        </Link>
      )}
      {group.subject.kind === 'source' && (
        <Link to={{ page: 'sources', id: group.subject.id }} className={link}>
          Open the source
        </Link>
      )}
      {may && held && <Button onClick={() => ownBudget(held.kind, group.subject.id, held.held)}>{own ? 'Change its budget' : 'Give it a budget of its own'}</Button>}
    </div>
  )
}

/** A signal's number: for a budget, a bar with its warning and its limit marked; otherwise the number as it reads. */
function Measure({ signal }: { signal: LoadSignal }) {
  const value = said(signal.value, signal.unit)
  if (!signal.budget) return <span className="text-sm text-ink-100 tabular-nums">{value}</span>
  const { warn, limit } = signal.budget.held
  const scale = Math.max(limit ?? (warn ?? 0) * 1.25, signal.value) * 1.05
  const at = (n: number) => `${Math.min(100, (n / scale) * 100)}%`
  return (
    <span className="block">
      <span className="relative block h-2 rounded-full bg-ink-800" aria-hidden>
        <span className={`absolute inset-y-0 left-0 rounded-full ${BAR[signal.level]}`} style={{ width: at(signal.value) }} />
        {warn !== undefined && <span className="absolute -inset-y-1 w-0.5 bg-amber" style={{ left: at(warn) }} />}
        {limit !== undefined && <span className="absolute -inset-y-1 w-0.5 bg-red" style={{ left: at(limit) }} />}
      </span>
      <span className="mt-1 block text-[12px] text-ink-400 tabular-nums">
        <span className="font-semibold text-ink-50">{value}</span>
        {warn !== undefined && ` of ${said(warn, signal.unit)} to warn`}
        {limit !== undefined && `${warn !== undefined ? ',' : ' of'} ${said(limit, signal.unit)} to refuse`}
        {signal.trend?.perWeek != null && `; ${weekly(signal.trend.perWeek)}`}
      </span>
    </span>
  )
}

/** How much something grew in a week, signed. */
const weekly = (n: number) => `${n >= 0.5 ? '+' : n <= -0.5 ? '−' : ''}${count(Math.abs(n))} a week`

/** The three areas the hub spends its time on, each with the names that cost it most. */
function Areas({ data, signals, name, reveal }: { data: LoadResponse; signals: LoadSignal[]; name: (id: string) => string; reveal: (id: string) => void }) {
  const times = areaTimes(data)
  const all = AREA_ORDER.reduce((n, a) => n + times[a], 0)
  const worst = new Map<string, SignalLevel>()
  for (const g of bySubject(signals)) worst.set(g.key, g.level)
  const spent = new Map<string, number>()
  for (const r of [...data.deriving, ...data.grids, ...data.relinking]) spent.set(r.blueprint, (spent.get(r.blueprint) ?? 0) + r.ms)
  const work = [...spent].map(([id, ms]) => ({ id, ms })).sort((a, b) => b.ms - a.ms)
  const rows: Record<LoadArea, { key: string; label: ReactNode; ms: number; list: string }[]> = {
    in: data.writing.map((r) => ({ key: `source:${r.source}`, label: <span className={mono}>{r.source}</span>, ms: r.ms, list: 'load-writing' })),
    work: work.map((r) => ({ key: `blueprint:${r.id}`, label: name(r.id), ms: r.ms, list: 'load-deriving' })),
    out: data.reading.map((r) => ({ key: `caller:${r.caller}`, label: r.caller, ms: r.ms, list: 'load-reading' })),
  }
  const lists: Record<LoadArea, { id: string; label: string }[]> = {
    in: [{ id: 'load-writing', label: `Every source (${data.writing.length})` }],
    work: [
      { id: 'load-deriving', label: `Deriving (${data.deriving.length})` },
      { id: 'load-grids', label: `Grids (${data.grids.length})` },
      { id: 'load-relinking', label: `Re-linking (${data.relinking.length})` },
    ],
    out: [
      { id: 'load-reading', label: `Every caller (${data.reading.length})` },
      { id: 'load-routes', label: `By route (${data.routes.length})` },
    ],
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {AREA_ORDER.map((a) => {
        const top = rows[a].slice(0, TOP)
        const most = Math.max(1, ...top.map((r) => r.ms))
        return (
          <Panel key={a} className="flex flex-col px-4 py-3">
            <div className="label">{AREAS[a].about}</div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h2 className="text-[16px] font-semibold text-ink-50">{AREAS[a].title}</h2>
              <span className="text-xl font-semibold text-ink-50 tabular-nums">{took(times[a])}</span>
            </div>
            <div className="mt-2 mb-1 h-1.5 overflow-hidden rounded-full bg-ink-800" aria-hidden>
              <div className="h-full" style={{ width: `${all ? (times[a] / all) * 100 : 0}%`, background: AREA_COLOR[a] }} />
            </div>
            <div className="mb-2 text-[12px] text-ink-400">{all ? Math.round((times[a] / all) * 100) : 0}% of the hub’s time</div>
            {top.length === 0 ? (
              <p className="py-2 text-sm text-ink-400">Nothing in this window.</p>
            ) : (
              <ul className="flex-1 space-y-2">
                {top.map((r) => {
                  const level = worst.get(r.key)
                  return (
                    <li key={r.key} className="text-[13px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 break-words text-ink-100">
                          <span className="flex w-2 shrink-0 justify-center">{level && <Lamp {...LAMP[level]} size="sm" title={levelSaid({ level })} />}</span>
                          <span className="min-w-0">{r.label}</span>
                        </span>
                        <span className="shrink-0 text-ink-300 tabular-nums">{took(r.ms)}</span>
                      </div>
                      <div className="mt-1 h-1 rounded-full bg-ink-800" aria-hidden>
                        <div className="h-full rounded-full" style={{ width: `${(r.ms / most) * 100}%`, background: AREA_COLOR[a] }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-800 pt-2">
              {lists[a].map((l) => (
                <Button key={l.id} onClick={() => reveal(l.id)}>
                  {l.label}
                </Button>
              ))}
            </div>
          </Panel>
        )
      })}
    </div>
  )
}

/** A section that folds: its title and what it holds stay in view. */
function Fold({ id, open, onToggle, title, summary, children }: { id: string; open: boolean; onToggle: () => void; title: string; summary: string; children: ReactNode }) {
  return (
    <Panel className="scroll-mt-4">
      <h2 id={id} className="scroll-mt-4">
        <button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-ink-850">
          {open ? <ChevronDown className="size-4 shrink-0 self-center text-ink-400" aria-hidden /> : <ChevronRight className="size-4 shrink-0 self-center text-ink-400" aria-hidden />}
          <span className="text-[15px] font-semibold text-ink-50">{title}</span>
          <span className="text-[13px] font-normal text-ink-400">{summary}</span>
        </button>
      </h2>
      {open && (
        <div id={`${id}-body`} className="border-t border-ink-800">
          {children}
        </div>
      )}
    </Panel>
  )
}

interface Column<T> {
  title: string
  hint?: string
  cell: (row: T) => ReactNode
}

/** Every list in full, each folded until it is asked for. */
function Lists({ data, name, open, toggle }: { data: LoadResponse; name: (id: string) => string; open: ReadonlySet<string>; toggle: (id: string) => void }) {
  const now = new Map(data.blueprints.map((b) => [b.id, b]))
  const blueprint = (id: string) => (
    <Link to={{ page: 'inventory', blueprint: id }} className={TAP} title={id}>
      {name(id)}
    </Link>
  )
  const entities = (id: string) => <Against used={now.get(id)?.entities ?? 0} budget={budgetFor(data.budgets, 'entities', id)} />
  const moved = new Map((data.held?.blueprints ?? []).map((b) => [b.id, b]))
  const held = data.blueprints.map((b) => ({ id: b.id, trend: moved.has(b.id) ? heldTrend(moved.get(b.id)!, b.entities, budgetFor(data.budgets, 'entities', b.id)) : undefined }))
  const fold = <T,>(id: string, title: string, about: string, rows: T[], key: (r: T) => string, ms: (r: T) => number, columns: Column<T>[]) => {
    const total = rows.reduce((n, r) => n + ms(r), 0)
    return (
      <Fold id={id} open={open.has(id)} onToggle={() => toggle(id)} title={title} summary={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}, ${took(total)} in all`}>
        <p className="border-b border-ink-800 px-4 py-2.5 text-[13px] text-ink-400">{about}</p>
        <Table title={title} rows={rows} id={key} ms={ms} columns={columns} />
      </Fold>
    )
  }
  return (
    <section className="space-y-3" aria-label="Every list">
      <h2 className="text-[15px] font-semibold text-ink-50">Every list</h2>
      <Fold id="load-held" open={open.has('load-held')} onToggle={() => toggle('load-held')} title="Blueprints: held" summary={heldSummary(data)}>
        <p className="border-b border-ink-800 px-4 py-2.5 text-[13px] text-ink-400">What each blueprint holds, and how it moved over the days its deleted entities are kept. The forecast follows the last four weeks; a blueprint whose entities expire levels where a day’s arrivals times their life comes to.</p>
        <Table title="Blueprints: held" rows={held} id={(r) => r.id} columns={[
          { title: 'Blueprint', cell: (r) => blueprint(r.id) },
          { title: 'Entities now', cell: (r) => entities(r.id) },
          { title: 'History', hint: 'What it held each day, as far back as its deleted entities are kept', cell: (r) => (r.trend ? <HeldSpark trend={r.trend} /> : '') },
          { title: 'A week', hint: 'How much it grew each week over the last four, after what left', cell: (r) => (r.trend?.perWeek == null ? '' : weekly(r.trend.perWeek)) },
          { title: 'In a month', hint: 'What it holds in 30 days at that pace', cell: (r) => (r.trend?.forecast.length ? count(r.trend.forecast[MONTH_DAYS - 1]!) : '') },
          { title: 'Levels at', hint: 'Where expiry holds it at that pace: a day’s arrivals times the days each lives', cell: (r) => (r.trend?.levels == null ? 'Never' : count(r.trend.levels)) },
        ]} />
      </Fold>
      {fold('load-deriving', 'Blueprints: deriving', 'Working out derived fields, status, and relations. A changed row sends everything that reads it back to be derived again.', data.deriving, (r) => r.blueprint, (r) => r.ms, [
        { title: 'Blueprint', cell: (r) => blueprint(r.blueprint) },
        { title: 'Entities now', cell: (r) => entities(r.blueprint) },
        { title: 'Reads each', hint: 'How many other entities one row of this blueprint reads, on average, now', cell: (r) => <Against used={now.get(r.blueprint)?.reads ?? 0} budget={budgetFor(data.budgets, 'reads', r.blueprint)} digits={1} /> },
        { title: 'Derived', hint: 'Entities derived in the window', cell: (r) => count(r.derived) },
        { title: 'Changed', hint: 'Derived rows that came out different', cell: (r) => count(r.changed) },
        { title: 'Readers per change', hint: 'Readers sent back to be derived for each row that changed', cell: (r) => (r.changed ? (r.cascaded / r.changed).toFixed(1) : '0') },
        { title: 'Per row', hint: 'Time to derive one row, on average', cell: (r) => took(r.derived ? r.ms / r.derived : 0) },
      ])}
      {fold('load-grids', 'Blueprints: grids', 'Building the shape of a grid: the count, the groups, and how each column shares out. It is built again when what the grid reads moves.', data.grids, (r) => r.blueprint, (r) => r.ms, [
        { title: 'Blueprint', cell: (r) => blueprint(r.blueprint) },
        { title: 'Entities now', cell: (r) => entities(r.blueprint) },
        { title: 'Builds', cell: (r) => count(r.builds) },
        { title: 'Rows per build', cell: (r) => count(r.builds ? r.rows / r.builds : 0) },
        { title: 'Average build', cell: (r) => took(r.builds ? r.ms / r.builds : 0) },
        { title: 'Spread', hint: 'Of each build, the time spent counting the spread of values under the grid, on average', cell: (r) => took(r.builds ? r.spreadMs / r.builds : 0) },
        { title: 'Columns spread', hint: 'Columns each build shared out, on average: chips, enums, booleans, lists, relations, and the hub’s own', cell: (r) => count(r.builds ? r.spreadColumns / r.builds : 0) },
      ])}
      {data.stars && data.stars.length > 0 &&
        fold('load-stars', 'Blueprints: favorites', 'What people’s stars cost the grids of each kind. A grid read by someone who starred something there puts their stars first and marks them, with two small lookups; a read by anyone else costs what it did before stars.', data.stars, (r) => r.blueprint, (r) => r.ms, [
          { title: 'Blueprint', cell: (r) => blueprint(r.blueprint) },
          { title: 'Stars now', hint: 'Stars its entities hold this moment, from every person', cell: (r) => count(r.stars) },
          { title: 'People', hint: 'People who starred something of it', cell: (r) => count(r.people) },
          { title: 'Grid reads', hint: 'Reads of its grids put in their reader’s stars order, in the window', cell: (r) => count(r.reads) },
          { title: 'Starred per read', hint: 'Rows each of those reads marked as starred, on average', cell: (r) => (r.reads ? (r.marked / r.reads).toFixed(1) : '0') },
          { title: 'Per read', hint: 'The stars’ own time in each of those reads, on average', cell: (r) => took(r.reads ? r.ms / r.reads : 0) },
        ])}
      {fold('load-relinking', 'Relations: re-linking', 'Working out the links a relation rule makes or a relation inherits. It is worked out again after a push, or a save, moves what it reads.', data.relinking, (r) => `${r.blueprint}.${r.relation}`, (r) => r.ms, [
        { title: 'Blueprint', cell: (r) => blueprint(r.blueprint) },
        { title: 'Relation', cell: (r) => <span className={mono}>{r.relation}</span> },
        { title: 'Filled by', hint: 'A relation rule, or a path the relation inherits along', cell: (r) => (r.by === 'rule' ? 'Rule' : 'Inherited') },
        { title: 'Passes', hint: 'Times it was worked out in the window', cell: (r) => count(r.passes) },
        { title: 'Read per pass', hint: 'Entities read each time it was worked out, on average: those it links, and those their paths or matches reached', cell: (r) => count(r.passes ? r.read / r.passes : 0) },
        { title: 'Links changed', hint: 'Links added or dropped in the window', cell: (r) => count(r.changed) },
        { title: 'Average pass', cell: (r) => took(r.passes ? r.ms / r.passes : 0) },
      ])}
      {fold('load-writing', 'Sources: writing', 'Entities each source sent. One sent in full is checked against what is stored; one named by a sighting costs next to nothing.', data.writing, (r) => r.source, (r) => r.ms, [
        {
          title: 'Source',
          cell: (r) => (
            <Link to={{ page: 'sources', id: r.source }} className={`${mono} ${TAP}`}>
              {r.source}
            </Link>
          ),
        },
        { title: 'Batches', cell: (r) => count(r.batches) },
        { title: 'Sent in full', cell: (r) => count(r.received) },
        { title: 'Sighted', hint: 'Entities named by their digest alone and taken as sent again', cell: (r) => count(r.sighted ?? 0) },
        { title: 'Changed', hint: 'Entities created, updated, or restored', cell: (r) => `${count(r.changed)} (${r.received ? Math.round((r.changed / r.received) * 100) : 0}%)` },
        { title: 'Fullest hour', hint: 'The most entities it changed in one hour of the window, against its budget', cell: (r) => <Against used={data.use.changes[r.source]?.peak ?? 0} budget={budgetFor(data.budgets, 'changes', r.source)} /> },
      ])}
      {fold('load-reading', 'Consumers: reading', 'API calls by who made them: a person, a token by its name, or anonymous for a call nobody signed. Pushes from sources are counted above.', data.reading, (r) => r.caller, (r) => r.ms, [
        { title: 'Caller', cell: (r) => <span className="break-all">{r.caller}</span> },
        { title: 'Calls', cell: (r) => count(r.calls) },
        { title: 'Fullest hour', hint: 'The most calls it made in one hour of the window, against its budget', cell: (r) => <Against used={data.use.calls[r.caller]?.peak ?? 0} budget={budgetFor(data.budgets, 'calls', r.caller)} /> },
        { title: 'Average', cell: (r) => took(r.calls ? r.ms / r.calls : 0) },
        { title: 'Answered', hint: 'Bytes answered, before compression', cell: (r) => bytes(r.bytes) },
        { title: 'Per call', hint: 'Bytes answered per call, before compression', cell: (r) => bytes(r.calls ? r.bytes / r.calls : 0) },
      ])}
      {fold('load-routes', 'Consumers: by route', 'The same calls, split by the route each took: which of a caller’s calls cost the time and the bytes.', data.routes, (r) => `${r.caller} ${r.route}`, (r) => r.ms, [
        { title: 'Caller', cell: (r) => <span className="break-all">{r.caller}</span> },
        { title: 'Route', cell: (r) => <span className={`${mono} break-all`}>{r.route}</span> },
        { title: 'Calls', cell: (r) => count(r.calls) },
        { title: 'Average', cell: (r) => took(r.calls ? r.ms / r.calls : 0) },
        { title: 'Answered', hint: 'Bytes answered, before compression', cell: (r) => bytes(r.bytes) },
        { title: 'Per call', hint: 'Bytes answered per call, before compression', cell: (r) => bytes(r.calls ? r.bytes / r.calls : 0) },
      ])}
      {data.database &&
        fold('load-database', 'Database: by work', 'What each kind of work asked of the database: a task of the hub’s, or the route a request took. The time is the statements’ own, so it is part of the lists above and never added to them.', data.database, (r) => r.work, (r) => r.ms, [
          { title: 'Work', cell: (r) => <span className={`${mono} break-all`}>{r.work}</span> },
          { title: 'Statements', cell: (r) => count(r.statements) },
          { title: 'Rows', hint: 'Rows the statements answered with or changed', cell: (r) => count(r.rows) },
          { title: 'Rows per statement', cell: (r) => count(r.statements ? r.rows / r.statements : 0) },
          { title: 'Average statement', cell: (r) => took(r.statements ? r.ms / r.statements : 0) },
        ])}
    </section>
  )
}

/**
 * Every field a grid may count, as last measured: the counts that cost more
 * than they show first, then the columns whose values repeat enough to be
 * worth counting. A person who may change the model opens the field from its
 * name and sets its count there.
 */
function Columns({ columns, blueprints, adminOnly, name, field, open, toggle }: { columns: LoadColumn[]; blueprints: Blueprint[]; adminOnly: string[]; name: (id: string) => string; field: (blueprint: string, field: string) => string; open: boolean; toggle: () => void }) {
  const canAuthor = useCan('model.edit')
  const admin = useIsAdmin()
  const [editing, setEditing] = useState<{ bp: Blueprint; name: string; anchor: HTMLElement } | null>(null)
  const of = new Map(blueprints.map((bp) => [bp.id, bp]))
  // Whether each is counted is read from the model as this page holds it, so a change made here shows at once.
  const rows = byFit(columns.map((c) => {
    const def = of.get(c.blueprint)?.fields[c.field]
    return def ? { ...c, spread: isSpread(def) } : c
  }))
  const costly = rows.filter((c) => columnFit(c) === 'costly').length
  const waiting = rows.filter((c) => columnFit(c) === 'candidate').length
  const oldest = rows.reduce<string | null>((at, c) => (at === null || c.measuredAt < at ? c.measuredAt : at), null)
  const summary = rows.length ? [costly && `${costly} ${costly === 1 ? 'count costs' : 'counts cost'} more than ${costly === 1 ? 'it shows' : 'they show'}`, waiting && `${waiting} could be counted`].filter(Boolean).join(', ') || `${rows.length} columns, each a fit` : 'Not measured yet'
  const fieldCell = (c: LoadColumn) => {
    const bp = of.get(c.blueprint)
    const label = field(c.blueprint, c.field)
    if (!bp?.fields[c.field]) return <span title={c.field}>{label}</span>
    // The same lock the model page reads: the hub's own blueprints, git's, and those only an admin changes open no editor here.
    const locked = lockOf(bp, canAuthor, !admin && adminOnly.includes(bp.id))
    if (locked) return <span title={`${c.field}: ${locked}`}>{label}</span>
    return (
      <button type="button" className={`${TAP} text-left`} title={`Edit ${label}: its count and the rest of its definition`} onClick={(e) => setEditing({ bp, name: c.field, anchor: e.currentTarget })}>
        {label}
      </button>
    )
  }
  return (
    <section className="space-y-3" aria-label="Columns">
      <Fold id="load-columns" open={open} onToggle={toggle} title="Columns: counts" summary={summary}>
        <p className="border-b border-ink-800 px-4 py-2.5 text-[13px] text-ink-400">
          How the values of each column a grid may count spread over its rows. A counted column is counted under the grid on every build: one whose values rarely repeat costs the most and draws slivers. One whose few values repeat across many rows would show at a glance if it were counted. How a value looks, a chip or not, costs nothing.
          {oldest && ` Measured every few hours; the oldest ${duration(Date.now() - Date.parse(oldest))} ago.`}
        </p>
        <Table
          title="Columns: counts"
          rows={rows}
          id={(c) => `${c.blueprint}:${c.field}`}
          columns={[
            {
              title: 'Column',
              cell: (c) => (
                <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                  {fieldCell(c)}
                  <span className="text-ink-400">on</span>
                  <Link to={{ page: 'inventory', blueprint: c.blueprint }} className={TAP} title={c.blueprint}>
                    {name(c.blueprint)}
                  </Link>
                </span>
              ),
            },
            { title: 'Counted', hint: 'Whether the grid counts it under it: the spread of values', cell: (c) => (c.spread ? 'Yes' : 'No') },
            { title: 'Rows', hint: 'Active and missing rows a grid opens on', cell: (c) => count(c.rows) },
            { title: 'Values', hint: 'Rows that hold a value', cell: (c) => count(c.values) },
            { title: 'Different', hint: 'How many different values there are', cell: (c) => count(c.different) },
            { title: 'Rows each', hint: 'How many rows hold each value, on average', cell: (c) => said(repeatsOf(c), 'decimal') },
            { title: 'Spread draws', hint: 'The share of values the spread under the grid draws as buckets of their own; the rest is "other"', cell: (c) => said(shownShare(c), 'percent') },
            {
              title: 'Fit',
              cell: (c) => {
                const fit = columnFit(c)
                if (fit === 'fine') return <span className="text-ink-400">Fits</span>
                if (fit === 'candidate') return <span className="text-ink-100">{FIT_SAID[fit]}</span>
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <Lamp {...LAMP.watch} size="sm" title={FIT_SAID[fit]} />
                    {FIT_SAID[fit]}
                  </span>
                )
              },
            },
          ]}
        />
      </Fold>
      {editing && <FieldPopover key={`${editing.bp.id}:${editing.name}`} bp={editing.bp} name={editing.name} anchor={editing.anchor} onClose={() => setEditing(null)} />}
    </section>
  )
}

/** A number beside the budget it is held to: amber past the warning, red past the limit, with a mark near it. */
function Against({ used, budget, digits = 0 }: { used: number; budget: Budget | undefined; digits?: number }) {
  const shown = digits ? used.toFixed(digits) : count(used)
  if (!budget) return <>{shown}</>
  const state = budgetState(used, budget)
  const of = budget.limit ?? budget.warn!
  const why = state === 'limit' ? 'Past its limit: the hub refuses what would add to it' : state === 'warn' ? 'Past its warning: a finding is raised' : state === 'near' ? 'Near its budget' : 'Within its budget'
  return (
    <span className="inline-flex items-center gap-1.5" title={`${why}. Warns at ${budget.warn === undefined ? 'nothing' : count(budget.warn)}, refuses at ${budget.limit === undefined ? 'nothing' : count(budget.limit)}.`}>
      {state !== 'ok' && <Lamp {...LAMP[state]} size="sm" title={why} />}
      <span className={state === 'limit' ? 'font-semibold text-red' : state === 'warn' ? 'font-semibold text-amber' : ''}>{shown}</span>
      <span className="text-ink-400"> of {count(of)}</span>
    </span>
  )
}

/** One kind of load as a table: what the columns say of each row, then its time and its share of the table's time as a bar with the number beside it. */
function Table<T>({ title, rows, id, ms, columns }: { title: string; rows: T[]; id: (row: T) => string; ms?: (row: T) => number; columns: Column<T>[] }) {
  const [all, setAll] = useState(false)
  const total = ms ? rows.reduce((sum, r) => sum + ms(r), 0) : 0
  const shown = all ? rows : rows.slice(0, FIRST)
  const th = 'label px-3 py-2 text-right whitespace-nowrap first:pl-4 first:text-left'
  const td = 'px-3 py-1.5 text-right whitespace-nowrap tabular-nums text-ink-200 first:pl-4 first:text-left first:whitespace-normal first:text-ink-100'
  if (rows.length === 0) return <div className="px-4 py-6 text-sm text-ink-400">Nothing in this window.</div>
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b border-ink-800">
              {columns.map((c) => (
                <th key={c.title} scope="col" className={th} title={c.hint}>
                  {c.title}
                </th>
              ))}
              {ms && (
                <>
                  <th scope="col" className={th}>
                    Time
                  </th>
                  <th scope="col" className={`${th} w-48 pr-4 text-left`}>
                    Share of time
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const share = ms && total ? (ms(r) / total) * 100 : 0
              return (
                <tr key={id(r)} className="border-b border-ink-800 last:border-b-0">
                  {columns.map((c, i) =>
                    i === 0 ? (
                      <th key={c.title} scope="row" className={`${td} font-normal`}>
                        {c.cell(r)}
                      </th>
                    ) : (
                      <td key={c.title} className={td}>
                        {c.cell(r)}
                      </td>
                    ),
                  )}
                  {ms && (
                    <>
                      <td className={td}>{took(ms(r))}</td>
                      <td className="py-1.5 pr-4 pl-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-ink-800" aria-hidden>
                            <div className="h-full rounded-full bg-orbit" style={{ width: `${Math.max(share, share ? 2 : 0)}%` }} />
                          </div>
                          <span className="w-10 shrink-0 text-right text-[12px] text-ink-300 tabular-nums">{share.toFixed(share < 10 ? 1 : 0)}%</span>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > FIRST && (
        <div className="border-t border-ink-800 px-4 py-2">
          <Button onClick={() => setAll(!all)}>{all ? `Show the first ${FIRST}` : `Show all ${rows.length}`}</Button>
        </div>
      )}
    </>
  )
}

