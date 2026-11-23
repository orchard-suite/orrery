// A change set in the web app: many runs, each with its own action, thing, and
// inputs, asked together for one decision. Its page reads as the change it
// is: the title and why it was asked, then every run grouped by action and by
// the inputs the runs share, each with what it runs on, then how each stands
// once it runs. One approval approves every run; a reject declines them all.
// The runs list shows a set as one line, and the start page's band offers its
// one decision.

import { Check, Layers, RotateCcw, Undo2, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { ChangeSetResponse, ChangeSetSummary } from '../../shared/api.ts'
import type { ActionInputDef } from '../../shared/model.ts'
import { DECISION_WORD, groupItems, setSaid, setState, type InputGroup } from '../change-sets.ts'
import { inputShown } from '../actions.ts'
import { useActions, useChangeSet, useChangeSetControl } from '../api.ts'
import { ago, when } from '../format.ts'
import { navigate } from '../router.ts'
import { useHere } from '../trail.ts'
import { RunMark, STATE_WORD } from './ActionRun.tsx'
import { BatchCounts } from './BatchLine.tsx'
import { Button, Empty, ErrorNote, Kicker, Link, Panel, input } from './ui.tsx'

export function ChangeSetPage({ id }: { id: string }) {
  const set = useChangeSet(id)
  const actions = useActions().data?.actions ?? []
  useHere(set.data?.title)
  if (set.isLoading) return <p className="py-12 text-sm text-ink-400">Loading…</p>
  if (set.error) return <div className="py-6"><ErrorNote error={set.error} /></div>
  const s = set.data
  if (!s) return <Empty>No change set {id}.</Empty>
  const defsOf = (action: string) => actions.find((a) => a.id === action)?.inputs ?? {}
  const groups = groupItems(s.items)
  return (
    <div className="space-y-6 py-6">
      <nav aria-label="Breadcrumb">
        <Kicker>
          <Link to={{ page: 'actions', id: null }} className="hover:text-ink-200">
            Self-service
          </Link>{' '}
          / change set <span className="font-mono normal-case tracking-normal">{s.id}</span>
        </Kicker>
      </nav>
      <div className="flex flex-wrap items-start gap-4">
        <Layers aria-hidden className="mt-1 size-7 text-ink-300" />
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="page-title">{s.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-300">
            <span className="flex items-center gap-1.5">
              <RunMark state={setState(s)} />
              <span className="text-ink-100">{s.decision === 'approved' ? (s.done ? 'ended' : 'running') : DECISION_WORD[s.decision]}</span>
            </span>
            <span>{setSaid(s)}</span>
            <span>
              Asked by <span className="text-ink-100">{s.by}</span>
              {s.through && <> through <span className="text-ink-100">{s.through}</span></>}{' '}
              <time dateTime={s.createdAt} title={when(s.createdAt)}>
                {ago(s.createdAt)}
              </time>
            </span>
            {s.retries && (
              <Link to={{ page: 'action-set', id: s.retries }} className="text-ink-100 underline hover:text-ink-50">
                Asks again for what failed of an earlier set
              </Link>
            )}
          </div>
        </div>
      </div>
      {s.note && (
        <Panel>
          <h2 className="border-b border-ink-800 px-4 py-2">
            <Kicker>Why</Kicker>
          </h2>
          <p className="whitespace-pre-line px-4 py-3 text-sm text-ink-100">{s.note}</p>
        </Panel>
      )}
      {s.decision === 'pending' ? <Decide set={s} /> : <Decided set={s} />}
      {s.decision === 'approved' && (
        <div className="flex flex-wrap items-center gap-3">
          <BatchCounts batch={s} />
          {s.canRetry && <Retry set={s} />}
        </div>
      )}
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.action} aria-labelledby={`set-${g.action}`}>
            <h2 id={`set-${g.action}`} className="flex items-baseline gap-2 text-base font-semibold text-ink-50">
              <Link to={{ page: 'actions', id: g.action }} className="hover:underline">
                {g.actionTitle}
              </Link>
              <span className="text-[13px] font-normal text-ink-400">
                {g.runs.toLocaleString('en-US')} {g.runs === 1 ? 'change' : 'changes'}
              </span>
            </h2>
            <div className="mt-2 space-y-3">
              {g.groups.map((ig) => (
                <Group key={ig.key} group={ig} defs={defsOf(g.action)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** The runs of one action that share their inputs: the inputs once, then each run with what it runs on and how it stands. */
function Group({ group, defs }: { group: InputGroup; defs: Record<string, ActionInputDef> }) {
  const said = Object.entries(group.inputs).flatMap(([name, value]) => {
    const text = inputShown(defs[name], value)
    if (!text) return []
    const titled = typeof value === 'string' && group.titles[value] ? group.titles[value] : Array.isArray(value) && value.every((v) => typeof v === 'string' && group.titles[v]) ? value.map((v) => group.titles[v as string]).join(', ') : null
    return [{ name: defs[name]?.title ?? name, text: titled ?? text }]
  })
  return (
    <Panel>
      {said.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 border-b border-ink-800 px-4 py-2 text-[13px]">
          {said.map((s) => (
            <div key={s.name} className="flex min-w-0 gap-1.5">
              <dt className="text-ink-400">{s.name}</dt>
              <dd className="min-w-0 break-words text-ink-100">{s.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <ul className="divide-y divide-ink-800/70">
        {group.items.map((i) => (
          <li key={i.run} className="flex items-center gap-2.5 px-4 py-2 text-[13px]">
            <RunMark state={i.state} />
            {i.entity ? (
              <Link to={{ page: 'entity', ...i.entity }} className="min-w-0 truncate text-ink-50 hover:underline">
                {i.entityTitle ?? i.entity.key}
              </Link>
            ) : (
              <span className="text-ink-200">Runs on nothing</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-400" title={i.summary ?? undefined}>
              {i.state === 'failed' || i.state === 'succeeded' ? (i.summary ?? STATE_WORD[i.state]) : STATE_WORD[i.state]}
              {i.attempt > 1 ? ` · try ${i.attempt}` : ''}
            </span>
            <Link to={{ page: 'action-run', id: i.run }} className="shrink-0 text-[12px] text-ink-200 underline hover:text-ink-50">
              Open the run
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** The one decision of a set that waits: approve every run, or reject them all, with a note; or, for whoever asked, withdraw it. */
function Decide({ set }: { set: ChangeSetResponse }) {
  const control = useChangeSetControl(set.id)
  const [note, setNote] = useState('')
  const noteId = useId()
  const waiting = set.counts.awaiting ?? 0
  const busy = control.approve.isPending || control.reject.isPending || control.withdraw.isPending
  const quorum = Math.max(1, ...set.items.map((i) => i.approvalsNeeded))
  const given = [...new Set(set.items.flatMap((i) => i.approvedBy.map((g) => g.by)))]
  return (
    <Panel className="space-y-3 border-amber/40 px-4 py-3">
      <p className="text-sm text-ink-100">
        {set.canDecide
          ? `One approval approves all ${waiting.toLocaleString('en-US')} of its changes, each as if you approved it alone.`
          : set.canWithdraw
            ? 'It waits for someone who may approve every change of it.'
            : 'It waits for someone who may approve every change of it. You may read it, not decide it.'}
      </p>
      {quorum > 1 && (
        <p className="text-sm text-ink-200" aria-live="polite">
          {given.length} of {quorum} approvals{given.length ? `: ${given.join(', ')}` : ''}.
        </p>
      )}
      {set.canDecide && (
        <div className="space-y-2">
          <label htmlFor={noteId} className="flex flex-col gap-1 text-[12px] text-ink-300">
            A note on your decision, for whoever asked
          </label>
          <textarea id={noteId} className={`${input} w-full max-w-xl`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="solid" disabled={busy} onClick={() => control.approve.mutate(note.trim() || undefined)}>
              <span className="flex items-center gap-1.5">
                <Check className="size-3.5" /> Approve all {waiting.toLocaleString('en-US')}
              </span>
            </Button>
            <Button kind="danger" disabled={busy} onClick={() => control.reject.mutate(note.trim() || undefined)}>
              <span className="flex items-center gap-1.5">
                <X className="size-3.5" /> Reject
              </span>
            </Button>
          </div>
        </div>
      )}
      {set.canWithdraw && (
        <Button disabled={busy} onClick={() => control.withdraw.mutate()}>
          <span className="flex items-center gap-1.5">
            <Undo2 className="size-3.5" /> Withdraw it
          </span>
        </Button>
      )}
      {[control.approve.error, control.reject.error, control.withdraw.error].map((e, i) => (e ? <ErrorNote key={i} error={e} /> : null))}
    </Panel>
  )
}

/** How a set that no longer waits was decided, by whom, and what they said. */
function Decided({ set }: { set: ChangeSetSummary }) {
  if (!set.decidedBy) return null
  return (
    <p className="text-sm text-ink-300">
      {DECISION_WORD[set.decision].replace(/^./, (c) => c.toUpperCase())} by <span className="text-ink-100">{set.decidedBy}</span>{' '}
      {set.decidedAt && (
        <time dateTime={set.decidedAt} title={when(set.decidedAt)}>
          {ago(set.decidedAt)}
        </time>
      )}
      {set.decisionNote ? `: ${set.decisionNote}` : ''}
    </p>
  )
}

/** Asks again for every change of the set that failed, as a new set for approval, and opens it. */
function Retry({ set }: { set: ChangeSetSummary }) {
  const control = useChangeSetControl(set.id)
  const failed = set.counts.failed ?? 0
  return (
    <span className="flex flex-col items-start gap-1">
      <Button kind="solid" disabled={control.retry.isPending} onClick={() => control.retry.mutate(undefined, { onSuccess: (next) => navigate({ page: 'action-set', id: next.id }) })}>
        <span className="flex items-center gap-1.5">
          <RotateCcw className="size-3.5" /> Ask again for the {failed.toLocaleString('en-US')} failed
        </span>
      </Button>
      {!!control.retry.error && <ErrorNote error={control.retry.error} />}
    </span>
  )
}

/** A change set as one row of the runs list: what it is called, what it changes, and how its runs stand. */
export function SetRunRow({ set, who }: { set: ChangeSetSummary; who: boolean }) {
  const cover = "after:absolute after:inset-0 after:content-['']"
  return (
    <li title={who ? `Asked by ${set.by}` : undefined} className="relative px-1 py-2 hover:bg-ink-850 focus-within:bg-ink-850">
      <div className="flex items-center gap-2.5">
        <RunMark state={setState(set)} />
        <Link to={{ page: 'action-set', id: set.id }} className={`min-w-0 truncate text-sm font-medium text-ink-50 hover:underline ${cover}`}>
          {set.title}
        </Link>
        <span className="shrink-0 rounded-sm border border-ink-700 px-1 text-[11px] text-ink-300">change set of {set.size.toLocaleString('en-US')}</span>
        {who && <span className="sr-only">, asked by {set.by}</span>}
        <time dateTime={set.createdAt} title={when(set.createdAt)} className="ml-auto shrink-0 pl-1 text-[12px] text-ink-400">
          {ago(set.createdAt)}
        </time>
      </div>
      <div className="mt-0.5 space-y-0.5 pl-6">
        <p className="truncate text-[12px] text-ink-300">{setSaid(set)}</p>
        {set.decision === 'approved' ? <BatchCounts batch={set} /> : <p className="text-[12px] text-ink-400">{DECISION_WORD[set.decision]}</p>}
      </div>
    </li>
  )
}

/** Approve all and Reject for a set where it waits, such as the start page's band; `what` names it to a screen reader. */
export function SetDecide({ set, what }: { set: ChangeSetSummary; what: string }) {
  const control = useChangeSetControl(set.id)
  const busy = control.approve.isPending || control.reject.isPending
  const error = control.approve.error ?? control.reject.error
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1.5">
        <Button kind="solid" onClick={() => control.approve.mutate(undefined)} disabled={busy}>
          Approve all {set.size.toLocaleString('en-US')}
          <span className="sr-only"> of {what}</span>
        </Button>
        <Button
          kind="danger"
          onClick={() => {
            const why = prompt('Why reject it? Whoever asked reads this.')
            if (why !== null) control.reject.mutate(why || undefined)
          }}
          disabled={busy}
        >
          Reject<span className="sr-only"> {what}</span>
        </Button>
      </div>
      {error && (
        <span role="alert" className="whitespace-normal text-[12px] text-red">
          {error.message}
        </span>
      )}
    </div>
  )
}
