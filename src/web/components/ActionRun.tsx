// A run of an action: its page, with what happened step by step, what it
// ended with, and the log as it grows, and the list of runs the Self-service
// pages show.

import { Check, ChevronRight, CircleDot, Circle, CircleHelp, Hourglass, Minus, RotateCcw, Undo2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { changeInput, kindOf } from '../../shared/input-kinds.ts'
import type { ChangeStatement } from '../../shared/change.ts'
import { ChangeStatementView, RouteView } from './ChangeStatement.tsx'
import { runChanges } from '../../shared/list-change.ts'
import { entityId, isFinished, owedOf, owedWords, type Action, type ActionInputDef, type ActionRun, type ActionRunState } from '../../shared/model.ts'
import { happened, iconOf, inputShown, named, outputsOf, ranInputs, targetOf, waits, wroteBackOf } from '../actions.ts'
import { RUNS_PAGE, runImageUrl, useActionRun, useActionRuns, useActions, useApprovals, useCan, useDecideRun, useScheduleApprovals, useSetApprovals, useViewingAs, useWhoAmI } from '../api.ts'
import { ago, day, duration, when } from '../format.ts'
import { Icon } from '../icons.tsx'
import { RUN_STATE, RunDrawer } from './ActionForm.tsx'
import { ListChangeView } from './ListChange.tsx'
import { Markdown } from './Markdown.tsx'
import { RunLog, STEP_ICON, STEP_WORD } from './RunLog.tsx'
import { toldOf, toldText } from '../told.ts'
import { Badge, Button, CopyButton, DownloadButton, Empty, ErrorNote, External, Kicker, Link, Panel, TabPanel, Tabs, input, useNow } from './ui.tsx'
import { BatchRunRow } from './BatchLine.tsx'
import { ScheduleCard } from './Schedules.tsx'
import { ScheduleDayRow } from './ScheduleLine.tsx'
import type { ActionBatchSummary, ChangeSetSummary, ScheduleDay } from '../../shared/api.ts'
import { SetRunRow } from './ChangeSet.tsx'
import { useHere, useVisit } from '../trail.ts'

/**
 * One input a run was given, read as its kind reads: a moment on the
 * reader's own clock with the instant behind it, an id letter by letter, and
 * anything else as words that keep their lines. An entity is named by its
 * title where the hub sent one in `titles`, with its id beside it.
 */
function Given({ def, value, titles = {} }: { def: ActionInputDef | undefined; value: unknown; titles?: Record<string, string> }) {
  const shows = kindOf(def?.type ?? 'string').shows
  const text = inputShown(def, value)
  if (!text) return <dd className="min-w-0 text-ink-400">Not given</dd>
  const ids = shows === 'entity' ? (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== '') : []
  if (ids.some((id) => titles[id])) {
    return (
      <dd className="min-w-0 space-y-1 text-ink-100">
        {ids.map((id) => (
          <div key={id} className="break-words">
            {titles[id] && <>{titles[id]} </>}
            <span className="break-all font-mono text-[12px] text-ink-400">{id}</span>
          </div>
        ))}
      </dd>
    )
  }
  if (shows === 'instant' && typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return (
      <dd className="min-w-0 text-ink-100">
        <time dateTime={value} title={value}>
          {text}
        </time>
      </dd>
    )
  }
  return <dd className={`min-w-0 whitespace-pre-wrap break-words text-ink-100 ${shows === 'entity' ? 'font-mono text-[12px]' : ''}`}>{text}</dd>
}

/**
 * A long text a run was given, such as a plan: folded under its title until
 * the reader opens it, then read exactly as it was sent. It can be copied or
 * kept as a file without opening it.
 */
function Attached({ run, name, title, text }: { run: string; name: string; title: string; text: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.replace(/\n$/, '').split('\n').length
  const body = `attached-${name}`
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <h2>
          <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-sm text-left hover:text-ink-100">
            <ChevronRight aria-hidden className={`size-3.5 text-ink-300 ${open ? 'rotate-90' : ''}`} />
            <Kicker>{title}</Kicker>
            <span className="text-[12px] text-ink-300">
              {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'}
            </span>
          </button>
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={text} what={title} />
          <DownloadButton text={text} file={`${run}-${name}.txt`} what={title} />
        </div>
      </div>
      {open && (
        <pre id={body} tabIndex={0} aria-label={title} className="max-h-[70vh] overflow-auto whitespace-pre border-t border-ink-800 px-4 py-3 font-mono text-[12px] text-ink-100">
          {text}
        </pre>
      )}
    </Panel>
  )
}

/** One run: what was asked, what the backend said, and the log as it grows. */
export function ActionRunPage({ id }: { id: string }) {
  const run = useActionRun(id)
  const actions = useActions()
  const [again, setAgain] = useState(false)
  // One clock for the whole page while the run is under way, so every time on it moves together.
  const now = useNow(!!run.data && !isFinished(run.data.state))
  useHere(run.data && named(actions.data?.actions.find((a) => a.id === run.data.action)?.title ?? run.data.action, run.data))
  if (run.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  if (!run.data) return <Empty>No run {id}.</Empty>
  const r = run.data
  const action = actions.data?.actions.find((a) => a.id === r.action)
  const title = action?.title ?? r.action
  // An input whose kind is prose is read, not glanced at: it gets its own panel, before the log.
  const isProse = (k: string, v: unknown) => shownAs(k, v) === 'prose'
  // An attachment is long and read only now and then: it gets its own panel too, folded until it is opened.
  const isAttached = (k: string, v: unknown) => shownAs(k, v) === 'attachment'
  const shownAs = (k: string, v: unknown) => (action?.inputs[k] && typeof v === 'string' && v.trim() !== '' ? kindOf(action.inputs[k].type).shows : null)
  // What the form asked for this run, in the order it asked, which the stored run does not keep; an input the action no longer has comes last.
  const given = ranInputs(action?.inputs, r.inputs)
  const prose = given.filter(([k, v]) => isProse(k, v)) as [string, string][]
  const attached = given.filter(([k, v]) => isAttached(k, v)) as [string, string][]
  // What the run does to each list it edits, against the list kept when it was asked: shown on its own, so whoever approves reads the change itself.
  const changed = Object.entries(runChanges(action?.inputs, r.inputs, r.current))
  // The change the run states is read whole, above the decision it asks for.
  const stating = changeInput(action?.inputs)
  const statement = stating && r.inputs[stating] && typeof r.inputs[stating] === 'object' ? (r.inputs[stating] as ChangeStatement) : null
  const plain = given.filter(([k, v]) => !isProse(k, v) && !isAttached(k, v) && !changed.some(([n]) => n === k) && !(statement && k === stating))
  const outputs = outputsOf(r)
  const wroteBack = wroteBackOf(r)
  const told = toldOf(r.id)
  return (
    <div className="space-y-6 py-6">
      <nav aria-label="Breadcrumb">
        <Kicker>
          <Link to={{ page: 'actions', id: null }} className="hover:text-ink-200">
            Self-service
          </Link>{' '}
          /{' '}
          <Link to={{ page: 'actions', id: r.action }} className="hover:text-ink-200">
            {title}
          </Link>{' '}
          / run <span className="font-mono normal-case tracking-normal">{r.id}</span>
        </Kicker>
      </nav>
      <div className="flex flex-wrap items-start gap-4">
        <Icon name={iconOf(action ?? {})} className="mt-1 size-8" />
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="page-title">
            {title}
            {r.entity && (
              <>
                <span className="text-ink-400"> on </span>
                <Link to={{ page: 'entity', ...r.entity }} className="hover:underline">
                  {targetOf(r)}
                </Link>
                {targetOf(r) !== r.entity.key && <span className="mt-1 block font-mono text-[12px] leading-snug font-normal tracking-normal wrap-anywhere text-ink-400">{r.entity.key}</span>}
              </>
            )}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-300">
            <StateBadge run={r} large />
            {r.label && <span className="text-ink-200">{r.label}</span>}
            <span>
              Asked by <span className="text-ink-100">{r.by}</span>
              {r.requestedFor && (
                <>
                  {' '}
                  for <span className="text-ink-100">{r.requestedFor}</span>
                </>
              )}{' '}
              <span title={when(r.createdAt)}>{ago(r.createdAt, now)}</span>
            </span>
            <span>{took(r, now)}</span>
          </div>
          {/* Announces each new state while the page is open. */}
          <div className="sr-only" aria-live="polite">
            {`Run ${STATE_WORD[r.state]}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {action?.canRun && (
            <Button onClick={() => setAgain(true)}>
              <span className="flex items-center gap-1.5">
                <RotateCcw className="size-3" /> Run again
              </span>
            </Button>
          )}
          {r.link && (
            <External href={r.link} className="btn btn-ghost">
              Watch it there
            </External>
          )}
        </div>
      </div>
      {r.changeSet && (
        <p className="text-sm text-ink-300">
          This run is one of a change set, decided as one.{' '}
          <Link to={{ page: 'action-set', id: r.changeSet }} className="text-ink-100 underline hover:text-ink-50">
            {r.state === 'awaiting' ? 'Read and decide the whole set' : 'Open the change set'}
          </Link>
        </p>
      )}
      {r.summary && <p className="max-w-3xl whitespace-pre-line text-sm text-ink-200">{r.summary}</p>}
      <Asks run={r} />
      {changed.length > 0 && (
        <Panel>
          <h2 className="border-b border-ink-800 px-4 py-2">
            <Kicker>What it changes</Kicker>
          </h2>
          <div className="divide-y divide-ink-800">
            {changed.map(([k, c]) => (
              <section key={k} aria-label={action?.inputs[k]?.title ?? k} className="px-4 py-3">
                <p className="mb-1.5 text-sm text-ink-300">
                  {action?.inputs[k]?.title ?? k}
                  <span className="text-ink-400">, against what it held when it was asked</span>
                </p>
                <ListChangeView change={c} text={(v) => kindOf(action!.inputs[k]!.type).text(v)} />
              </section>
            ))}
          </div>
        </Panel>
      )}
      {statement && <ChangeStatementView statement={statement} digest={r.statementDigest} waiting={r.state === 'awaiting'} />}
      {statement && r.routed && <RouteView routing={r.routed} statement={statement} />}
      {r.decidedBy && (r.state === 'returned' || r.note) && <DecisionNote run={r} />}
      {r.state === 'awaiting' && !r.changeSet && <Decide run={r} />}
      {r.state === 'queued' && !r.changeSet && <Withdraw run={r} />}
      {r.state === 'running' && r.canStop && <Stop run={r} />}
      {prose.map(([k, v]) => (
        <Panel key={k}>
          <h2 className="border-b border-ink-800 px-4 py-2">
            <Kicker>{action?.inputs[k]?.title ?? k}</Kicker>
          </h2>
          <Markdown text={v} className="px-4 py-3" />
        </Panel>
      ))}
      {attached.map(([k, v]) => (
        <Attached key={k} run={r.id} name={k} title={action?.inputs[k]?.title ?? k} text={v} />
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-6">
          {told !== undefined && <Told answer={told} />}
          {(outputs.length > 0 || r.images.length > 0) && <Result run={r.id} outputs={outputs} images={r.images} />}
          {wroteBack.length > 0 && <WroteBack fields={wroteBack} />}
          <RunLog run={r} now={now} />
        </div>
        <div className="space-y-6">
          <Panel>
            <h2 className="border-b border-ink-800 px-4 py-2">
              <Kicker>What happened</Kicker>
            </h2>
            <Timeline run={r} action={action} now={now} />
          </Panel>
          {(plain.length > 0 || prose.length + attached.length + changed.length + (statement ? 1 : 0) === 0) && (
            <Panel>
              <h2 className="border-b border-ink-800 px-4 py-2">
                <Kicker>Inputs</Kicker>
              </h2>
              <dl className="divide-y divide-ink-800 text-sm">
                {plain.map(([k, v]) => (
                  <div key={k} className="flex gap-3 px-4 py-2">
                    <dt className="w-32 shrink-0 text-ink-300">{action?.inputs[k]?.title ?? k}</dt>
                    <Given def={action?.inputs[k]} value={v} titles={r.inputTitles} />
                  </div>
                ))}
                {plain.length === 0 && <div className="px-4 py-3 text-ink-400">None.</div>}
              </dl>
            </Panel>
          )}
        </div>
      </div>
      {again && action && <RunDrawer action={action} start={{ entity: r.entity ? entityId(r.entity) : null, inputs: r.inputs }} onClose={() => setAgain(false)} />}
    </div>
  )
}

export const STATE_WORD: Record<ActionRunState, string> = { awaiting: 'waiting for approval', queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', unknown: 'outcome unknown', declined: 'declined', cancelled: 'cancelled', returned: 'sent back' }

/** A run's state in a word, with the try it is on past its first: a run waiting for its next try is retrying, and one waiting for the start its route names starts later, not merely queued. */
export function StateBadge({ run, large = false }: { run: Pick<ActionRun, 'state'> & Partial<Pick<ActionRun, 'attempt' | 'retryAt'>>; large?: boolean }) {
  // A run held before its first try waits for the start its route names; one held after a failed try is retrying.
  const word = run.retryAt && run.state === 'queued' ? ((run.attempt ?? 1) > 1 ? 'retrying' : 'starts later') : STATE_WORD[run.state]
  return (
    <Badge className={`border-ink-600 ${large ? 'px-2 py-0.5 text-[12px]' : ''}`}>
      <span className={RUN_STATE[run.state]}>{word}</span>
      {(run.attempt ?? 1) > 1 && <span className="ml-1 text-ink-400">· try {run.attempt}</span>}
    </Badge>
  )
}

/** How long a run took, or has taken so far, from when it started. Nothing for a run that never started. */
function took(r: ActionRun, now: number): string {
  if (!r.startedAt) return ''
  const from = new Date(r.startedAt).getTime()
  return r.finishedAt ? `took ${duration(new Date(r.finishedAt).getTime() - from)}` : `running for ${duration(now - from)}`
}

/** What happened to the run, in order, each part with how it stands and how long it took. A step the backend named sits under the running of the run. */
function Timeline({ run, action, now }: { run: ActionRun; action: Action | undefined; now: number }) {
  const all = happened(run, action, now)
  return (
    <ol aria-label="What happened" className="px-4 py-3">
      {all.map((s, i) => (
        <li key={i} className={`relative flex gap-3 last:pb-0 ${all[i + 1]?.under ? 'pb-2' : 'pb-4'}`}>
          {i < all.length - 1 && <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-ink-700" />}
          <span className={`flex shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 ${s.under ? 'm-[3px] size-[18px]' : 'size-6'}`}>{STEP_ICON[s.status]}</span>
          {s.under ? (
            <div className="flex min-w-0 flex-1 items-baseline gap-3 pt-0.5 text-[13px]">
              <span className="min-w-0 break-words text-ink-200">
                {s.label}
                <span className="sr-only">, {STEP_WORD[s.status]}</span>
              </span>
              <span className="ml-auto shrink-0 text-[12px] text-ink-400">{s.detail}</span>
            </div>
          ) : (
            <div className="min-w-0 pt-0.5 text-sm">
              <div className={s.status === 'waiting' || s.status === 'skipped' ? 'text-ink-400' : 'text-ink-100'}>
                {s.label}
                <span className="sr-only">, {STEP_WORD[s.status]}</span>
              </div>
              <div className="text-[12px] text-ink-400">
                {[s.detail, s.at && <span key="at" title={when(s.at)}>{ago(s.at, now)}</span>].filter(Boolean).map((part, j) => (
                  <span key={j}>
                    {j > 0 && ' · '}
                    {part}
                  </span>
                ))}
              </div>
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

/** What the backend said the run ended with, by name. A value that is a web address is a link. Whoever may see the run sees these. */
/** What the backend answered, held by this tab alone: the hub kept none of it. */
function Told({ answer }: { answer: string }) {
  const text = toldText(answer)
  return (
    <section aria-label="Answer" className="rounded border border-edge bg-ink-900 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="label">Answer</h2>
        <CopyButton text={text} what="the answer" />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-ink-100">{text || 'It answered with nothing.'}</pre>
      <p className="mt-2 text-xs text-ink-500">Shown once. Orrery did not keep it: it is gone when you leave or reload this page.</p>
    </section>
  )
}

function Result({ run, outputs, images }: { run: string; outputs: [string, string][]; images: string[] }) {
  return (
    <Panel>
      <h2 className="border-b border-ink-800 px-4 py-2">
        <Kicker>Result</Kicker>
      </h2>
      <dl className="divide-y divide-ink-800 text-sm">
        {images.map((name) => (
          <div key={name} className="flex items-start gap-3 px-4 py-2">
            <dt className="w-24 shrink-0 break-words pt-0.5 font-mono text-[12px] text-ink-300 sm:w-32">{name}</dt>
            <dd className="min-w-0 flex-1">
              <img src={runImageUrl(run, name)} alt={name} className="max-h-96 max-w-full rounded-sm border border-ink-700" />
            </dd>
          </div>
        ))}
        {outputs.map(([name, value]) => (
          <div key={name} className="flex items-start gap-3 px-4 py-2">
            <dt className="w-24 shrink-0 break-words pt-0.5 font-mono text-[12px] text-ink-300 sm:w-32">{name}</dt>
            <dd className="flex min-w-0 flex-1 items-start gap-3">
              {
                <>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 font-mono text-[12px] text-ink-100">
                    {/^https?:\/\/\S+$/.test(value) ? (
                      <External href={value} className="underline">
                        {value}
                      </External>
                    ) : (
                      value
                    )}
                  </span>
                  <CopyButton text={value} what={name} />
                </>
              }
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** The fields the run wrote back on what it ran on once it succeeded, each with what it held before. */
function WroteBack({ fields }: { fields: ReturnType<typeof wroteBackOf> }) {
  return (
    <Panel>
      <h2 className="border-b border-ink-800 px-4 py-2">
        <Kicker>Wrote back</Kicker>
      </h2>
      <dl className="divide-y divide-ink-800 text-sm">
        {fields.map((w) => (
          <div key={w.field} className="flex items-start gap-3 px-4 py-2">
            <dt className="w-24 shrink-0 break-words pt-0.5 font-mono text-[12px] text-ink-300 sm:w-32">{w.field}</dt>
            <dd className="grid min-w-0 flex-1 gap-1 sm:grid-cols-2 sm:gap-3">
              <div className="min-w-0">
                <span className="label text-ink-500">Was</span>
                <p className="whitespace-pre-wrap break-words font-mono text-[12px] text-ink-300">{w.was}</p>
              </div>
              <div className="min-w-0">
                <span className="label text-ink-500">Now</span>
                <p className="whitespace-pre-wrap break-words font-mono text-[12px] text-ink-100">{w.now}</p>
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** What a run asks for beyond its action: the tool tiers approving it grants, and the run it asks again for. Nothing for a run that asks for neither. */
function Asks({ run }: { run: ActionRun }) {
  const tiers = run.tiers ?? []
  if (!tiers.length && !run.revises) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-300">
      {tiers.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          {run.state === 'awaiting' ? 'Approving it grants its tools' : 'Asked for its tools'}
          {tiers.map((t) => (
            <Badge key={t} className="border-ink-600">
              {t}
            </Badge>
          ))}
        </span>
      )}
      {run.revises && (
        <span>
          Asks again for{' '}
          <Link to={{ page: 'action-run', id: run.revises }} className="text-ink-100 underline">
            a run sent back
          </Link>
        </span>
      )}
    </div>
  )
}

/** The note its decider left on a run: what to change, for one sent back, or why, for one approved or declined. */
function DecisionNote({ run }: { run: ActionRun }) {
  const verb = run.state === 'returned' ? 'Sent back' : run.state === 'declined' ? 'Declined' : 'Approved'
  return (
    <Panel className={run.state === 'returned' ? 'border-amber/40' : undefined}>
      <h2 className="border-b border-ink-800 px-4 py-2">
        <Kicker>
          {verb}
          {run.decidedBy ? ` by ${run.decidedBy}` : ''}
        </Kicker>
      </h2>
      <p className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-ink-100">{run.note ?? 'No note was left.'}</p>
    </Panel>
  )
}

/** Approve, send back, or decline, for whoever may. A run sent back says what to change; a declined one is over. */
function Decide({ run }: { run: ActionRun }) {
  const viewing = useViewingAs()
  const me = useWhoAmI()
  const decide = useDecideRun(run.id, run.statementDigest)
  const [note, setNote] = useState('')
  const own = me.data?.identity.name === run.by
  const canApprove = !!run.canDecide && !viewing
  const need = run.approvalsNeeded ?? 1
  const given = run.approvedBy ?? []
  const busy = decide.approve.isPending || decide.decline.isPending || decide.sendBack.isPending
  return (
    <Panel className="space-y-3 border-amber/40 px-4 py-3">
      {need > 1 && !run.routeAsks && (
        <p className="text-sm font-medium text-ink-50" aria-live="polite">
          {given.length} of {need} approvals{given.length ? `: ${given.map((g) => g.by).join(', ')}` : ''}. It starts when {need} different people have approved; a decline from anyone ends it.
        </p>
      )}
      {run.routeAsks && (
        <p className="text-sm font-medium text-ink-50" aria-live="polite">
          {need > 0 ? `Its action asks ${need} approval${need > 1 ? 's' : ''}, and its route asks ${run.routeAsks.need} more from the people it names.` : `Its route asks ${run.routeAsks.need} approval${run.routeAsks.need > 1 ? 's' : ''} from the people it names.`} It waits for {owedWords(owedOf(run))}
          {given.length ? `; approved so far by ${given.map((g) => g.by).join(', ')}` : ''}. A decline from anyone ends it.
        </p>
      )}
      <div className="text-sm text-ink-100">{waitsWords(run, own, canApprove)}</div>
      {run.batch && (
        <p className="text-[12px] text-ink-300">
          This run is one of a batch.{' '}
          <Link to={{ page: 'action-batch', id: run.batch }} className="text-ink-100 underline hover:text-ink-50">
            {canApprove ? 'Approve every run that waits on the batch’s page' : 'Open the batch'}
          </Link>
        </p>
      )}
      {canApprove && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-[12px] text-ink-300">
            A note on your decision: why you approve or decline it, or what to change to send it back
            <textarea className={`${input} w-full max-w-xl`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="solid" onClick={() => decide.approve.mutate(note.trim() || undefined)} disabled={busy}>
              Approve
            </Button>
            <Button onClick={() => decide.sendBack.mutate(note.trim())} disabled={busy || !note.trim()} title={note.trim() ? undefined : 'Write what to change first'}>
              Send back
            </Button>
            <Button kind="danger" onClick={() => decide.decline.mutate(note.trim())} disabled={busy}>
              Decline
            </Button>
          </div>
        </div>
      )}
      {own && !viewing && (
        <Button kind="ghost" onClick={() => decide.withdraw.mutate()} disabled={decide.withdraw.isPending}>
          Withdraw it
        </Button>
      )}
      <ErrorNote error={decide.approve.error ?? decide.sendBack.error ?? decide.decline.error ?? decide.withdraw.error} />
    </Panel>
  )
}

/** What a run that waits says to its reader: whose approval it waits for, and whether that is theirs. */
export function waitsWords(run: Pick<ActionRun, 'heldFor' | 'approvers'>, own: boolean, canApprove: boolean): string {
  if (run.approvers?.length) return canApprove ? 'This run waits for your approval: you are one of the approvers it names.' : own ? 'You asked for this run. The approvers it names decide it.' : 'This run waits for the approvers it names.'
  if (run.heldFor === 'self') return own ? (canApprove ? 'You asked for this run, and it waits for your own approval. Read it, then decide.' : 'This run waits for your own approval.') : 'This run waits for the approval of the person who asked for it.'
  if (own) return canApprove ? 'You asked for this run. This action lets you approve it yourself.' : 'Waiting for someone else to approve this.'
  return canApprove ? 'This run waits for your approval.' : 'This run waits for approval.'
}

/** For the person who asked, a run approved but not started yet can still be withdrawn. Nothing for anyone else. */
function Withdraw({ run }: { run: ActionRun }) {
  const viewing = useViewingAs()
  const me = useWhoAmI()
  const decide = useDecideRun(run.id)
  if (viewing || me.data?.identity.name !== run.by) return null
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
      Not started yet.
      <Button kind="ghost" onClick={() => decide.withdraw.mutate()} disabled={decide.withdraw.isPending}>
        Withdraw it
      </Button>
      <ErrorNote error={decide.withdraw.error} />
    </div>
  )
}

/** For the person who asked, or an admin, a job's run under way can be stopped: the run ends cancelled and its job is stopped. Asked twice, since work under way is lost. */
function Stop({ run }: { run: ActionRun }) {
  const viewing = useViewingAs()
  const decide = useDecideRun(run.id)
  const [sure, setSure] = useState(false)
  if (viewing) return null
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
      {sure ? 'Stop its job now? What it has done so far stays done.' : 'Its job is running.'}
      {sure ? (
        <>
          <Button kind="danger" onClick={() => decide.withdraw.mutate()} disabled={decide.withdraw.isPending}>
            Stop the job
          </Button>
          <Button kind="ghost" onClick={() => setSure(false)} disabled={decide.withdraw.isPending}>
            Keep it running
          </Button>
        </>
      ) : (
        <Button kind="ghost" onClick={() => setSure(true)}>
          Stop it
        </Button>
      )}
      <ErrorNote error={decide.withdraw.error} />
    </div>
  )
}

/** Approve or decline one run from the list of those waiting, without opening it. A reason for declining is given on its page, and so is the note that sends it back. */
export function RowDecide({ run, what }: { run: ActionRun; what: string }) {
  const decide = useDecideRun(run.id, run.statementDigest)
  return <DecideButtons what={what} busy={decide.approve.isPending || decide.decline.isPending} error={decide.approve.error ?? decide.decline.error} onApprove={() => decide.approve.mutate()} onDecline={() => decide.decline.mutate('')} />
}

/** Approve and Decline side by side, for anything that waits for the reader's word, and what went wrong under them. `what` names it to a screen reader. */
export function DecideButtons({ what, busy, error, onApprove, onDecline }: { what: string; busy: boolean; error: unknown; onApprove: () => void; onDecline: () => void }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1.5">
        <Button kind="solid" onClick={onApprove} disabled={busy}>
          Approve<span className="sr-only"> {what}</span>
        </Button>
        <Button kind="danger" onClick={onDecline} disabled={busy}>
          Decline<span className="sr-only"> {what}</span>
        </Button>
      </div>
      {!!error && (
        <span role="alert" className="whitespace-normal text-[12px] text-red">
          {error instanceof Error ? error.message : String(error)}
        </span>
      )}
    </div>
  )
}

export type RunsTab = 'mine' | 'approvals' | 'all'

/** How many runs a list reads at first, and how many more each time a person asks for older ones. The hub reads at most `MOST`. */
const PAGE = RUNS_PAGE
const MOST = 500

/** A run's state as a mark. `RunMark` says the state's word with it, so the mark is never alone. */
const RUN_MARK: Record<ActionRunState, ReactNode> = {
  awaiting: <Hourglass aria-hidden className="size-3.5 text-amber" />,
  queued: <Circle aria-hidden className="size-3.5 text-ink-400" />,
  running: <CircleDot aria-hidden className="size-3.5 text-orbit" />,
  succeeded: <Check aria-hidden className="size-3.5 text-green" />,
  failed: <X aria-hidden className="size-3.5 text-red" />,
  unknown: <CircleHelp aria-hidden className="size-3.5 text-amber" />,
  declined: <Minus aria-hidden className="size-3.5 text-ink-400" />,
  cancelled: <Minus aria-hidden className="size-3.5 text-ink-400" />,
  returned: <Undo2 aria-hidden className="size-3.5 text-amber" />,
}

/** A run's state: its mark for the eye, its word for a screen reader and a hover. */
export function RunMark({ state }: { state: ActionRunState }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center" title={STATE_WORD[state]}>
      {RUN_MARK[state]}
      <span className="sr-only">{STATE_WORD[state]}</span>
    </span>
  )
}

/**
 * The runs, newest first, as rows under the day each was asked: the
 * person's own, those waiting for their approval, or everyone's. With
 * `action`, only that action's runs. Where its parent gives it a height, the
 * heading, tabs, and filters stay put and the rows scroll beneath them. With
 * `start` it opens on that tab; without, on what waits for the person.
 */
export function RunsPanel({ action, start }: { action?: string; start?: RunsTab }) {
  const me = useWhoAmI().data?.identity.name ?? ''
  const { runs: approvals, settled } = useApprovals()
  const decides = useCan('actions.approve')
  const awaitingSchedules = useScheduleApprovals()
  const awaitingSets = useSetApprovals()
  const canApprove = decides || approvals.length > 0 || awaitingSets.length > 0
  const actions = useActions().data?.actions ?? []
  const [state, setState] = useVisit(`runs.${action ?? ''}.state`, '')
  const [only, setOnly] = useVisit(`runs.${action ?? ''}.only`, action ?? '')
  const [limit, setLimit] = useState(PAGE)
  const scoped = action ?? only
  const setsHere = scoped ? awaitingSets.filter((s) => s.actions.some((a) => a.id === scoped)) : awaitingSets
  const waiting = (scoped ? approvals.filter((r) => r.action === scoped).length : approvals.length) + setsHere.length + (scoped ? 0 : awaitingSchedules.length)
  // The panel opens on what waits for the person, once the hub has said whether anything does. From then on the tab is theirs: a run that arrives or leaves never moves it.
  const [opened, setTab] = useState<RunsTab | null>(start ?? null)
  if (opened === null && settled) setTab(waiting > 0 ? 'approvals' : 'mine')
  const tab = opened ?? 'mine'
  // A new question starts from its newest page again.
  const pick =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value)
      setLimit(PAGE)
    }
  const params = new URLSearchParams({ limit: String(limit) })
  if (scoped) params.set('action', scoped)
  // What waits for approval is decided run by run, but a change set's runs are decided with their set.
  if (tab === 'approvals') {
    params.set('state', 'awaiting')
    params.set('sets', 'apart')
  } else if (state) params.set('state', state)
  if (tab === 'mine') params.set('by', me)
  // A batch is one line among the runs, and what a schedule fired one line a schedule a day, each opened to show its own; what waits for approval is decided run by run.
  if (tab !== 'approvals') {
    params.set('group', 'origin')
    params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone)
  }
  // No rows are asked for until the tab is known, so the person's own runs never flash before the approvals.
  const runs = useActionRuns(params, !!me && opened !== null)
  const rows = (runs.data?.runs ?? []).filter((r) => tab !== 'approvals' || (r.canDecide && !r.changeSet))
  const tabs: { id: RunsTab; label: ReactNode }[] = [
    { id: 'mine', label: 'Mine' },
    ...(canApprove ? [{ id: 'approvals' as const, label: <span className="flex items-center gap-1.5">Needs my approval{waiting > 0 && <span className="rounded-full bg-amber px-1.5 text-[10px] leading-4 text-ink-950">{waiting}</span>}</span> }] : []),
    { id: 'all', label: 'All' },
  ]
  const filtered = !!state || (!action && !!only)
  const none = filtered ? 'No runs match.' : tab === 'mine' ? 'You have not run anything here yet.' : tab === 'approvals' ? 'Nothing waits for your approval.' : 'No runs yet.'
  const panelId = action ? `runs-${action}` : 'runs'
  const grouped = tab !== 'approvals'
  const days = byDay([
    ...rows.map((run): Line => ({ kind: 'run', run, at: run.createdAt })),
    ...(grouped ? (runs.data?.batches ?? []) : []).map((batch): Line => ({ kind: 'batch', batch, at: batch.createdAt })),
    ...(grouped ? (runs.data?.sets ?? []) : []).map((set): Line => ({ kind: 'set', set, at: set.createdAt })),
    ...(grouped ? (runs.data?.schedules ?? []) : []).map((line): Line => ({ kind: 'schedule', line, at: line.lastAt })),
  ])
  return (
    <section aria-labelledby={`${panelId}-h`} className="flex min-h-0 min-w-0 flex-col">
      <h2 id={`${panelId}-h`} className="text-lg font-semibold tracking-tight text-ink-50">
        Runs
      </h2>
      <div className="mt-2 border-b border-ink-800">
        <Tabs id={panelId} label="Which runs" tabs={tabs} value={tab} onChange={pick(setTab)} />
      </div>
      {(!action || tab !== 'approvals') && (
        <div className="mt-3 flex gap-2">
          {!action && (
            <select aria-label="Action" className={`${input} min-w-0 flex-1 text-[12px]`} value={only} onChange={(e) => pick(setOnly)(e.target.value)}>
              <option value="">Every action</option>
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          )}
          {tab !== 'approvals' && (
            <select aria-label="State" className={`${input} min-w-0 flex-1 text-[12px]`} value={state} onChange={(e) => pick(setState)(e.target.value)}>
              <option value="">Any state</option>
              {Object.entries(STATE_WORD).map(([s, word]) => (
                <option key={s} value={s}>
                  {word}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <TabPanel id={panelId} value={tab} className="mt-1 min-h-0 flex-1 overflow-y-auto pr-2 pb-8 [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]">
        {tab === 'approvals' && setsHere.length > 0 && (
          <div className="mt-3">
            <h3 id={`${panelId}-sets`} className="mb-1 text-[12px] font-medium text-ink-400">Change sets</h3>
            <ul aria-labelledby={`${panelId}-sets`} className="divide-y divide-ink-800/70 border-y border-ink-800/70">
              {setsHere.map((s) => (
                <SetRunRow key={s.id} set={s} who />
              ))}
            </ul>
          </div>
        )}
        {tab === 'approvals' && !action && awaitingSchedules.length > 0 && (
          <div className="mt-3 space-y-2">
            <h3 className="text-[12px] font-medium text-ink-400">Schedules</h3>
            {awaitingSchedules.map((sc) => (
              <ScheduleCard key={sc.id} s={sc} />
            ))}
          </div>
        )}
        {days.length === 0 && !(tab === 'approvals' && ((!action && awaitingSchedules.length > 0) || setsHere.length > 0)) ? (
          <p className="py-6 text-sm text-ink-400">{runs.isLoading || opened === null ? 'Loading…' : none}</p>
        ) : (
          days.map(([d, list], i) => (
            <div key={d}>
              <h3 id={`${panelId}-day-${i}`} className="mt-4 mb-1 text-[12px] font-medium text-ink-400">{d}</h3>
              <ul aria-labelledby={`${panelId}-day-${i}`} className="divide-y divide-ink-800/70 border-y border-ink-800/70">
                {list.map((l) =>
                  l.kind === 'run' ? (
                    <RunRow key={l.run.id} run={l.run} action={actions.find((a) => a.id === l.run.action)} me={me} scoped={!!action} who={tab !== 'mine'} decide={tab === 'approvals'} />
                  ) : l.kind === 'batch' ? (
                    <BatchRunRow key={l.batch.id} batch={l.batch} action={actions.find((a) => a.id === l.batch.action)} who={tab !== 'mine'} />
                  ) : l.kind === 'set' ? (
                    <SetRunRow key={l.set.id} set={l.set} who={tab !== 'mine'} />
                  ) : (
                    <ScheduleDayRow key={`${l.line.schedule}|${l.line.day}`} line={l.line} action={actions.find((a) => a.id === l.line.action)} me={me} who={tab !== 'mine'} />
                  ),
                )}
              </ul>
            </div>
          ))
        )}
        {runs.data?.more && limit < MOST && (
          <button type="button" onClick={() => setLimit(limit + PAGE)} disabled={runs.isFetching} className="mt-3 block py-1 text-[13px] font-medium text-ink-200 hover:text-ink-50 disabled:text-ink-400">
            {runs.isFetching ? 'Loading…' : 'Show older runs'}
          </button>
        )}
      </TabPanel>
    </section>
  )
}

/** One line of the runs list: a run asked alone, a batch or a change set standing for all of its runs, or a schedule's day standing for everything it fired then. */
type Line = { kind: 'run'; run: ActionRun; at: string } | { kind: 'batch'; batch: ActionBatchSummary; at: string } | { kind: 'set'; set: ChangeSetSummary; at: string } | { kind: 'schedule'; line: ScheduleDay; at: string }

/** Lines under the local day each was asked, newest first. */
function byDay(lines: Line[]): [string, Line[]][] {
  const days = new Map<string, Line[]>()
  for (const l of [...lines].sort((a, b) => b.at.localeCompare(a.at))) {
    const d = day(l.at)
    days.set(d, [...(days.get(d) ?? []), l])
  }
  return [...days]
}

/**
 * One run as a row, on one line: its state as a mark, what ran, on what, and
 * when it was asked. A second line only where there is something to know or
 * to do: why it failed, what it was sent back with, or on whom it waits. On an action's own page the row
 * leads with what it ran on. The whole row opens the run; on the approvals
 * tab it also approves or declines. Where the runs are not all the reader's
 * own, who asked is said on a hover and to a screen reader.
 */
export function RunRow({ run: r, action, me, scoped, who, decide }: { run: ActionRun; action: Action | undefined; me: string; scoped: boolean; who: boolean; decide: boolean }) {
  const cover = "after:absolute after:inset-0 after:content-['']"
  const title = action?.title ?? r.action
  const on = targetOf(r)
  const by = r.by === me ? 'you' : r.by
  const wait = waits(r, action, me)
  const more = r.state === 'failed' ? (r.summary ?? r.label) : r.state === 'returned' ? r.note : wait && who ? `${wait} · asked by ${by}` : wait
  return (
    <li title={who ? `Asked by ${by}` : undefined} className="relative px-1 py-2 hover:bg-ink-850 focus-within:bg-ink-850">
      <div className="flex items-center gap-2.5">
        <RunMark state={r.state} />
        <Link to={{ page: 'action-run', id: r.id }} className={`min-w-0 truncate text-sm font-medium text-ink-50 hover:underline ${cover}`}>
          {scoped ? (on ?? `Run ${r.id}`) : title}
        </Link>
        {!scoped && on && <span className="min-w-0 truncate text-[13px] text-ink-300">{on}</span>}
        {who && <span className="sr-only">, asked by {by}</span>}
        <time dateTime={r.createdAt} title={when(r.createdAt)} className="ml-auto shrink-0 pl-1 text-[12px] text-ink-400">
          {ago(r.createdAt)}
        </time>
      </div>
      {more && (
        <div className="mt-0.5 truncate pl-6 text-[12px] text-ink-300" title={more}>
          {more}
        </div>
      )}
      {decide && (
        <div className="relative z-10 mt-2 pl-6">
          <RowDecide run={r} what={`${named(title, r)}, asked by ${r.by}`} />
        </div>
      )}
    </li>
  )
}
