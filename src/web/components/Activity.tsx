import { Bot, ChevronDown, ChevronRight, Cpu, HardDriveUpload, User } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ActionBatchSummary } from '../../shared/api.ts'
import { ACTIVITY_CATEGORIES, ACTOR_KINDS, CHANGE_KINDS, type ActivityCategory, type ActorKind, type Change } from '../../shared/model.ts'
import { useActions, useHolds, useChanges, useSources } from '../api.ts'
import { short, when } from '../format.ts'
import { BatchCounts, BatchCover, batchAsked, batchSize, batchTook } from './BatchLine.tsx'
import { Badge, Button, Empty, ErrorNote, input, Link, Panel } from './ui.tsx'
import { useVisit } from '../trail.ts'

const ACTORS: Record<ActorKind, { label: string; hint: string; icon: ReactNode }> = {
  user: { label: 'People', hint: 'What people did in the web app', icon: <User className="size-3" /> },
  token: { label: 'Agents', hint: 'What agents and scripts did with an access token', icon: <Bot className="size-3" /> },
  source: { label: 'Sources', hint: 'What pushers, runners, and git sources wrote', icon: <HardDriveUpload className="size-3" /> },
  hub: { label: 'Hub', hint: 'What the hub did by itself: expiry, purges, abandoned runs', icon: <Cpu className="size-3" /> },
}
const CATEGORIES: Record<ActivityCategory, string> = { estate: 'Estate', runs: 'Runs', model: 'Model', layout: 'Layout', sources: 'Sources', secrets: 'Secrets', access: 'Access', actions: 'Actions' }
const SPANS = { '1h': 'Last hour', '24h': 'Last day', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'Everything kept' } as const
const HOURS: Record<keyof typeof SPANS, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720, all: 0 }
const PAGE = 200

/** The activity log: every change to the estate, the model, and who may do what, with who made it. */
export function Activity() {
  const allowed = useHolds('audit.view')
  const sources = useSources()
  const [actors, setActors] = useVisit<ActorKind[]>('activity.actors', [...ACTOR_KINDS])
  const [categories, setCategories] = useVisit<ActivityCategory[]>('activity.categories', [...ACTIVITY_CATEGORIES])
  const [problems, setProblems] = useVisit('activity.problems', false)
  const [grouped, setGrouped] = useVisit('activity.grouped', true)
  const [kind, setKind] = useVisit('activity.kind', '')
  const [source, setSource] = useVisit('activity.source', '')
  const [actor, setActor] = useVisit('activity.actor', '')
  const [blueprint, setBlueprint] = useVisit('activity.blueprint', '')
  const [span, setSpan] = useVisit<keyof typeof SPANS>('activity.span', '24h')
  const [limit, setLimit] = useState(PAGE)
  // The window opens when the span is picked, so a refetch asks for the same rows plus the new ones.
  const [since, setSince] = useVisit('activity.since', () => sinceFor('24h'))

  const params = new URLSearchParams({ limit: String(limit) })
  if (actors.length < ACTOR_KINDS.length) params.set('actorKind', actors.join(',') || '-')
  if (categories.length < ACTIVITY_CATEGORIES.length) params.set('category', categories.join(',') || '-')
  if (problems) params.set('outcome', 'refused,failed')
  if (kind) params.set('kind', kind)
  if (source) params.set('source', source)
  if (actor.trim()) params.set('actor', actor.trim())
  if (blueprint.trim()) params.set('blueprint', blueprint.trim())
  if (since) params.set('since', since)
  // A batch is one row, the one that asked it, unless the reader looks for one kind of row or only for what went wrong: then every row shows.
  const folds = grouped && !kind && !problems
  if (folds) params.set('fold', 'batches')
  const changes = useChanges(params, allowed)

  if (!allowed) return <Empty>The activity log needs the "audit.view" permission.</Empty>
  const rows = changes.data?.changes ?? []
  const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  const chip = (on: boolean) => `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${on ? 'border-ink-400 bg-ink-800 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`
  return (
    <div className="space-y-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Activity</h1>
        <span className="text-[13px] text-ink-400">
          {rows.length}
          {changes.data?.nextBefore ? '+' : ''} shown
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <select className={input} aria-label="Since" value={span} onChange={(e) => (setSpan(e.target.value as keyof typeof SPANS), setSince(sinceFor(e.target.value as keyof typeof SPANS)), setLimit(PAGE))}>
            {Object.entries(SPANS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select className={input} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {CHANGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select className={input} aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.data?.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <input className={`${input} w-44`} aria-label="Who" placeholder="Who" value={actor} onChange={(e) => setActor(e.target.value)} />
          <input className={`${input} w-40`} aria-label="Blueprint" placeholder="Blueprint" value={blueprint} onChange={(e) => setBlueprint(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap gap-1.5">
          {ACTOR_KINDS.map((k) => (
            <button key={k} type="button" className={chip(actors.includes(k))} title={ACTORS[k].hint} onClick={() => setActors(toggle(actors, k))}>
              {ACTORS[k].icon}
              {ACTORS[k].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ACTIVITY_CATEGORIES.map((k) => (
            <button key={k} type="button" className={chip(categories.includes(k))} onClick={() => setCategories(toggle(categories, k))}>
              {CATEGORIES[k]}
            </button>
          ))}
        </div>
        <button type="button" className={chip(problems)} title="Only what was refused for lack of a permission, or failed" onClick={() => setProblems(!problems)}>
          Refused and failed only
        </button>
        <button type="button" className={chip(folds)} disabled={!!kind || problems} title="A batch shows as one row, opened to show each of its runs" onClick={() => setGrouped(!grouped)}>
          Batches as one row
        </button>
      </div>
      <ErrorNote error={changes.error} />
      {changes.data && rows.length === 0 && <Empty>Nothing matches.</Empty>}
      {rows.length > 0 && (
        <Panel className="divide-y divide-ink-800">
          {rows.map((c) => {
            const batch = folds && c.kind === 'action.batched' && typeof c.detail.batch === 'string' ? changes.data?.batches?.[c.detail.batch] : undefined
            return batch ? <BatchRow key={c.id} c={c} batch={batch} /> : <Row key={c.id} c={c} />
          })}
        </Panel>
      )}
      {changes.data?.nextBefore && limit < 1000 && <Button onClick={() => setLimit(Math.min(limit + PAGE, 1000))}>Show older</Button>}
      {changes.data?.nextBefore && limit >= 1000 && <div className="text-[12px] text-ink-500">Showing the newest 1000. Narrow the filters to reach further back.</div>}
    </div>
  )
}

function Row({ c }: { c: Change }) {
  const who = c.actor ?? c.source ?? 'hub'
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-sm md:flex-nowrap">
      <span className="shrink-0 text-[12px] text-ink-500 tabular-nums md:w-32" title={c.at}>
        {when(c.at)}
      </span>
      <span className="flex max-w-full min-w-0 items-center md:w-52 md:shrink-0 gap-1.5 truncate text-[13px] text-ink-200" title={`${ACTORS[c.actorKind].label}: ${who}${c.actor && c.source && c.source !== 'ui' ? ` through source ${c.source}` : ''}`}>
        <span className="shrink-0 self-center text-ink-500">{ACTORS[c.actorKind].icon}</span>
        <span className="truncate">{who}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] md:w-44 text-ink-300">
        {c.kind}
        {c.outcome !== 'ok' && <Badge className={c.outcome === 'refused' ? 'border-amber/60 text-amber' : 'border-red-dim text-red'}>{c.outcome}</Badge>}
      </span>
      <span className="basis-full truncate text-[13px] md:w-64 md:shrink-0 md:basis-auto">
        {c.blueprint && c.key ? (
          <Link to={{ page: 'entity', blueprint: c.blueprint, key: c.key }} className="hover:underline">
            {c.blueprint}:{c.key}
          </Link>
        ) : (
          <span className="text-ink-500">{c.blueprint ?? ''}</span>
        )}
      </span>
      <span className="min-w-0 basis-full truncate text-[12px] text-ink-400 md:flex-1 md:basis-0" title={JSON.stringify(c.detail, null, 1)}>
        {summary(c.detail)}
      </span>
    </div>
  )
}

/** A batch as one row of the log: who asked it and how its runs stand; opened, every row the batch wrote. */
function BatchRow({ c, batch }: { c: Change; batch: ActionBatchSummary }) {
  const [open, setOpen] = useState(false)
  const title = useActions().data?.actions.find((a) => a.id === batch.action)?.title ?? batch.action
  const size = batchSize(batch)
  const took = batchTook(batch)
  const asked = batchAsked(batch)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm md:flex-nowrap">
        <span className="shrink-0 text-[12px] text-ink-500 tabular-nums md:w-32" title={c.at}>
          {when(c.at)}
        </span>
        <span className="flex max-w-full min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-200 md:w-52 md:shrink-0">
          <span className="shrink-0 text-ink-500">{ACTORS[c.actorKind].icon}</span>
          <span className="truncate">{c.actor ?? c.source ?? 'hub'}</span>
        </span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex shrink-0 items-center gap-1 font-mono text-[12px] text-ink-300 hover:text-ink-100 md:w-44">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          batch
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <BatchCover batch={batch} className="h-8 w-12" />
          <span className="min-w-0 space-y-0.5">
            <Link to={{ page: 'action-batch', id: batch.id }} className="block truncate text-[13px] font-medium text-ink-100 hover:underline">
              {title}
              {asked ? ` · ${asked}` : ''} on {size.toLocaleString('en-US')}
              {took ? ` · took ${took}` : batch.done ? '' : ' · running'}
            </Link>
            <BatchCounts batch={batch} />
          </span>
        </span>
      </div>
      {open && <BatchRows id={batch.id} />}
    </div>
  )
}

/** Every row of one batch, newest first: its runs' ends, retries, and cancels. */
function BatchRows({ id }: { id: string }) {
  const changes = useChanges(new URLSearchParams({ batch: id, limit: '1000' }), true)
  if (!changes.data) return <p className="px-4 py-2 pl-12 text-[12px] text-ink-400">{changes.error ? 'Could not read its rows.' : 'Loading its rows…'}</p>
  return (
    <div className="ml-8 border-l border-ink-700 bg-ink-900/40">
      {changes.data.changes.map((c) => (
        <Row key={c.id} c={c} />
      ))}
      {changes.data.nextBefore && (
        <p className="px-4 py-2 text-[12px] text-ink-400">
          The newest 1000 shown.{' '}
          <Link to={{ page: 'action-batch', id }} className="text-ink-100 hover:underline">
            Open the batch
          </Link>{' '}
          for every run.
        </p>
      )}
    </div>
  )
}

function sinceFor(span: keyof typeof SPANS): string {
  return HOURS[span] ? new Date(Date.now() - HOURS[span] * 3_600_000).toISOString() : ''
}

function summary(detail: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue
    if (k === 'entities') continue
    parts.push(`${k}: ${short(v, 60)}`)
  }
  return parts.join(' · ')
}
