// What the Self-service pages say of an action and of a run. Every read of
// what a hub one release back does not send is here, so a page from this
// release still draws against that hub.

import type { ActionsResponse, ServerEvent } from '../shared/api.ts'
import { askedInputs, formSections } from '../shared/asked.ts'
import { inputText, kindOf } from '../shared/input-kinds.ts'
import { ACTION_ICON, entityId, isFinished, type Action, type Home, type ActionInputDef, type ActionRun, type ActionStats, type Blueprint, type Entity, type Pin } from '../shared/model.ts'
import { duration, exact, short } from './format.ts'
import { stepTimes } from './runlog.ts'

/** An action as a page holds it: its definition, and what a current hub says beside it. */
export type Shown = Action & { iconShown?: string; stats?: ActionStats; homeShown?: Home | null }

/** The icon an action is drawn with. */
export function iconOf(a: Pick<Shown, 'icon' | 'iconShown'>): string {
  return a.iconShown ?? a.icon ?? ACTION_ICON
}

/** How many failures in a row make an action one that is failing. */
const FAILING_FROM = 3

/** That an action is failing, in words, or null when it is not. */
export function failing(a: Pick<Shown, 'stats'>): string | null {
  const failed = a.stats?.failedInARow ?? 0
  return failed >= FAILING_FROM ? `Failed the last ${failed} runs` : null
}

/** How long an action usually takes, in words, or null until the hub knows. */
export function usual(a: Pick<Shown, 'stats'>): string | null {
  const seconds = a.stats?.usualSeconds
  if (seconds === null || seconds === undefined) return null
  return `Usually takes ${seconds < 1 ? 'under a second' : duration(seconds * 1000)}`
}

/**
 * A stored input as its reader reads it: a moment in their own time, and
 * anything else as its kind says. Nothing for nothing given. An input the
 * action no longer defines is read as text.
 */
export function inputShown(def: Pick<ActionInputDef, 'type' | 'many'> | undefined, value: unknown): string {
  const as = def ?? { type: 'string' as const, many: Array.isArray(value) }
  if (kindOf(as.type).shows !== 'instant') return inputText(as, value)
  const moment = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? exact(v) : inputText(as, v))
  return Array.isArray(value) ? value.map(moment).join(', ') : moment(value)
}

/** What a run was on, as a person names it: its title, or its key when the title is not known. Null for a run on nothing. */
export function targetOf(r: Pick<ActionRun, 'entity' | 'entityTitle'>): string | null {
  return r.entity ? r.entityTitle || r.entity.key : null
}

/** A run said in a few words: what ran, and on what. */
export function named(title: string, r: Pick<ActionRun, 'entity' | 'entityTitle'>): string {
  const on = targetOf(r)
  return on ? `${title} on ${on}` : title
}

/** What waits for the reader's word, counted in words: the runs, the schedules, or both. */
export function waitingWords(w: { runs: number; sets: number; schedules: number }, end = 'for you'): string {
  const count = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
  const parts = ([[w.runs, 'run'], [w.sets, 'change set'], [w.schedules, 'schedule']] as const).filter(([n]) => n > 0).map(([n, one]) => count(n, one))
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
  return `${said} ${w.runs + w.sets + w.schedules === 1 ? 'waits' : 'wait'} ${end}`
}

/** How many recent runs the start page offers again. */
const RECENT = 5

/** The newest run of each action and target, from runs given newest first. */
export function recent(runs: ActionRun[], most = RECENT): ActionRun[] {
  const seen = new Set<string>()
  const out: ActionRun[] = []
  for (const r of runs) {
    const what = `${r.action}\u0000${r.entity ? entityId(r.entity) : ''}`
    if (seen.has(what)) continue
    seen.add(what)
    out.push(r)
    if (out.length === most) break
  }
  return out
}

/** On whom a run that has not started waits, or null for one that has. `action` is the run's, when the reader has it. */
export function waits(r: Pick<ActionRun, 'state' | 'by' | 'approvalsNeeded' | 'approvedBy'>, action: Pick<Action, 'backend'> | undefined, me: string): string | null {
  if (r.state === 'awaiting') return (r.approvalsNeeded ?? 1) > 1 ? `Waits for approval: ${(r.approvedBy ?? []).length} of ${r.approvalsNeeded}` : 'Waits for approval'
  if (r.state !== 'queued') return null
  if (action?.backend.type === 'caller') return r.by === me ? 'Waits for you to start it' : 'Waits for whoever asked to start it'
  if (action?.backend.type === 'runner') return `Queued for ${action.backend.runner}`
  if (action?.backend.type === 'job') return `Queued for ${action.backend.starter} to start its job`
  return 'Queued'
}

/** The values a run ended with, each as text, in the order the hub holds them. None from a hub that holds none. */
export function outputsOf(r: Partial<Pick<ActionRun, 'outputs'>>): [string, string][] {
  return Object.entries(r.outputs ?? {}).map(([name, value]) => [name, String(value)])
}

/** What a run wrote back on its entity, each field with what it held before and what it holds now, as text. A hub one release back sends none. */
export function wroteBackOf(r: Partial<Pick<ActionRun, 'wroteBack'>>): { field: string; was: string; now: string }[] {
  return (r.wroteBack ?? []).map((w) => ({ field: w.field, was: valueText(w.was), now: valueText(w.now) }))
}

/** A value written back, as it reads: a list one item to a line, nothing as a dash. */
function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : '—'
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** One thing that happened to a run, or has yet to: done, under way, failed, still to come, or never reached. */
export interface Happened {
  label: string
  status: 'done' | 'now' | 'failed' | 'unknown' | 'waiting' | 'skipped'
  /** When it happened, where that is one moment. */
  at?: string | null
  detail?: string
  /** A step the backend named, which sits under the running of the run. */
  under?: boolean
}

/**
 * What happened to a run, in order: who asked, how long it waited for
 * approval and to be picked up, how long it ran, each step its backend named
 * with how long that took, and how it ended. A wait or a step still under way
 * is measured to `now`.
 */
export function happened(r: ActionRun, action: (Pick<Action, 'approval'> & Partial<Pick<Action, 'backend'>>) | undefined, now: number): Happened[] {
  const asked = Date.parse(r.createdAt)
  const out: Happened[] = [{ label: 'Asked', status: 'done', at: r.createdAt, detail: `by ${r.by}` }]
  const withdrawn = r.state === 'cancelled' ? { label: 'Cancelled', status: 'failed' as const, at: r.finishedAt, detail: cancelledWhy(r) } : null
  if (action?.approval || r.decidedAt || r.state === 'awaiting') {
    const waited = r.decidedAt ? duration(Date.parse(r.decidedAt) - asked) : null
    const by = r.decidedBy ? `by ${r.decidedBy}` : null
    const need = r.approvalsNeeded ?? 1
    const given = r.approvedBy ?? []
    if (r.state === 'awaiting') out.push({ label: need > 1 ? `Waiting for approval: ${given.length} of ${need}` : 'Waiting for approval', status: 'now', detail: [given.length ? `approved by ${given.map((g) => g.by).join(', ')}` : null, `${duration(now - asked)} so far`].filter(Boolean).join('; ') })
    else if (withdrawn && !r.decidedAt) out.push(withdrawn)
    else if (r.state === 'declined') out.push({ label: 'Declined', status: 'failed', at: r.decidedAt, detail: [by, waited && `after ${waited}`].filter(Boolean).join(', ') || undefined })
    else if (r.state === 'returned') out.push({ label: 'Sent back', status: 'failed', at: r.decidedAt, detail: [by, waited && `after ${waited}`].filter(Boolean).join(', ') || undefined })
    else out.push({ label: waited ? `Waited ${waited} for approval` : 'Approved', status: 'done', at: r.decidedAt, detail: waited ? `Approved${by ? ` ${by}` : ''}` : (by ?? undefined) })
  }
  const finished = isFinished(r.state)
  const queued = Date.parse(r.decidedAt ?? r.createdAt)
  if (r.startedAt) {
    const started = Date.parse(r.startedAt)
    const waited = started - queued
    out.push({ label: waited >= 1000 ? `Queued ${duration(waited)}` : 'Started', status: 'done', at: r.startedAt, detail: r.claimedBy ? `Picked up by ${action?.backend?.type === 'job' ? 'starter' : 'runner'} ${r.claimedBy}` : undefined })
    const ran = (r.finishedAt ? Date.parse(r.finishedAt) : now) - started
    out.push(finished ? { label: `Ran for ${duration(ran)}`, status: 'done' } : { label: 'Running', status: 'now', detail: `for ${duration(ran)}` })
    for (const step of stepTimes(r, now)) out.push({ label: step.name, status: step.status, detail: step.status === 'now' ? `${duration(step.ms)} so far` : duration(step.ms), under: true })
  } else if (r.state === 'queued') out.push({ label: 'Queued', status: 'now', detail: `Waiting to be picked up, ${duration(now - queued)} so far` })
  else out.push({ label: 'Started', status: finished ? 'skipped' : 'waiting', detail: finished ? 'Never started' : undefined })
  if (r.state === 'succeeded') out.push({ label: 'Succeeded', status: 'done', at: r.finishedAt })
  else if (r.state === 'failed') out.push({ label: 'Failed', status: 'failed', at: r.finishedAt })
  else if (r.state === 'unknown') out.push({ label: 'Outcome unknown', status: 'unknown', at: r.finishedAt, detail: 'Nothing said how it ended: check what it did before you run it again' })
  else if (withdrawn && !out.includes(withdrawn)) out.push(withdrawn)
  else if (!finished) out.push({ label: 'Finished', status: 'waiting' })
  return out
}

/** Why a run was cancelled: the log line that ended it. */
function cancelledWhy(r: Pick<ActionRun, 'log'>): string | undefined {
  return [...r.log].reverse().find((l) => /^(withdrawn|stopped|replaced|not started)/.test(l.message))?.message
}

/** An action's home as the reader sees it, or null when it has none, they may not see it, or the hub says nothing of one. */
export function homeOf(a: Pick<Shown, 'homeShown'>): Home | null {
  return a.homeShown ?? null
}

/**
 * The section of the start page an action's tile sits in: its home's, named
 * by the home's entity id, else its group's, named by the group. The empty
 * name is the last section, for what belongs to none.
 */
export function sectionOf(a: Pick<Shown, 'group' | 'homeShown'>): string {
  return a.homeShown?.id ?? a.group ?? ''
}

/** A section of the start page: the name the shared layout knows it by, and the home it is the section of, if it is one. */
export interface Section {
  key: string
  home: Home | null
}

/** Which run of sections one is in: the reader's own homes, everything else with a name, and the last. A section moves only within its run. */
const runOf = (s: Section): number => (s.key === '' ? 2 : s.home?.yours ? 0 : 1)

/** The order everyone shares: what the layout names, as it names them, then the other homes by title, then the other groups by name. */
function shared(sections: Section[], order: string[]): Section[] {
  const rank = (s: Section) => (order.includes(s.key) ? order.indexOf(s.key) : order.length + (s.home ? 0 : 1))
  const called = (s: Section) => s.home?.title ?? s.key
  return sections.filter((s) => s.key !== '').sort((a, b) => rank(a) - rank(b) || called(a).localeCompare(called(b)))
}

/**
 * The sections of the start page, in the order a reader gets them: the homes
 * they own first, then the rest in the shared order, then what belongs to no
 * section.
 */
export function sectionsOf(actions: Pick<Shown, 'group' | 'homeShown'>[], order: string[]): Section[] {
  const found = new Map<string, Section>()
  for (const a of actions) {
    const key = sectionOf(a)
    if (!found.get(key)?.home) found.set(key, { key, home: homeOf(a) })
  }
  const all = [...found.values()]
  return [...shared(all, order), ...all.filter((s) => s.key === '')].sort((a, b) => runOf(a) - runOf(b))
}

/**
 * The shared order with one section moved a place up or down among the
 * sections of its run, or null when it is at that end. What is saved is the
 * order everyone shares: it never holds the lift that puts one reader's own
 * homes first, and never the last section, which stays last.
 */
export function movedSection(sections: Section[], order: string[], key: string, by: -1 | 1): string[] | null {
  const i = sections.findIndex((s) => s.key === key)
  const from = sections[i]
  const to = sections[i + by]
  if (!from || !to || from.key === '' || runOf(from) !== runOf(to)) return null
  const next = shared(sections, order).map((s) => s.key).filter((k) => k !== key)
  next.splice(next.indexOf(to.key) + (by === 1 ? 1 : 0), 0, key)
  return next
}

/** What the last section is called. */
export const NO_SECTION = 'Everything else'

/** What a person pinned of one kind, actions unless it says, in the order of their pins, among those a page offers. A pin to anything else is passed over. */
export function pinnedOf<A extends { id: string }>(pins: Pin[], offered: A[], kind: Pin['kind'] = 'action'): A[] {
  const byId = new Map(offered.map((a) => [a.id, a]))
  return pins.flatMap((p) => (p.kind === kind && byId.has(p.id) ? [byId.get(p.id)!] : []))
}

/** The pins with one moved a place earlier or later, or null when it is already at that end. */
/** The pins with `first` put first, in its order, and the rest after them as they were: what the hub makes of an order it is sent. */
export function reordered(pins: Pin[], first: Pin[]): Pin[] {
  const named = (p: Pin) => first.some((f) => f.kind === p.kind && f.id === p.id)
  return [...first.filter((f) => pins.some((p) => p.kind === f.kind && p.id === f.id)), ...pins.filter((p) => !named(p))]
}

export function movedPin(pins: Pin[], pin: Pin, by: -1 | 1): Pin[] | null {
  const i = pins.findIndex((p) => p.kind === pin.kind && p.id === pin.id)
  const j = i + by
  if (i < 0 || j < 0 || j >= pins.length) return null
  const next = [...pins]
  next.splice(i, 1)
  next.splice(j, 0, pin)
  return next
}

/**
 * Whether an event moves the list of actions a page holds. Two things it
 * says of an action follow the estate: its home's title and icon, and what
 * the reader owns, which decides which homes are theirs and what they may
 * run. A home moves with its own entity, with a title of its blueprint that
 * landed, or with its blueprint in an estate change. What the reader owns
 * moves with any blueprint in `reads`, which a hub one release back does
 * not send. An estate change that names nothing moves both.
 */
export function actionsMoved(event: ServerEvent, held: { actions: Pick<Shown, 'homeShown'>[]; reads?: ActionsResponse['reads'] } | undefined): boolean {
  if (!held) return false
  const homes = held.actions.flatMap((a) => (a.homeShown ? [a.homeShown.entity] : []))
  const reads = held.reads ?? []
  if (event.type === 'entity') return reads.includes(event.blueprint) || homes.some((h) => h.blueprint === event.blueprint && h.key === event.key)
  if (event.type === 'derived') return event.blueprints.some((b) => reads.includes(b)) || homes.some((h) => event.titled.includes(h.blueprint))
  if (event.type === 'estate') return event.blueprints ? event.blueprints.some((b) => reads.includes(b) || homes.some((h) => h.blueprint === b)) : homes.length > 0 || reads.length > 0
  return false
}

/** One step of a form walked a section at a time. */
export interface WalkStep {
  /** The same for as long as the form is open: `target`, a section by its place among the action's, or `rest`. */
  key: string
  title: string
  description?: string
  /** The inputs asked on it, in order. */
  inputs: string[]
  /** The step that asks what the action runs on. */
  target: boolean
}

/**
 * The steps a walked form takes for the inputs it asks: what it runs on
 * first, under `lead`, when the form asks for that, then each section that
 * holds an asked input, then what no section names. A section holding none
 * is no step, so the count is of the steps there are to take.
 */
export function walkSteps(action: Pick<Action, 'inputs' | 'sections'>, asked: readonly string[], lead: string | null): WalkStep[] {
  const steps: WalkStep[] = lead === null ? [] : [{ key: 'target', title: lead, inputs: [], target: true }]
  for (const group of formSections(action, asked)) {
    const place = (action.sections ?? []).findIndex((s) => s.inputs.includes(group.inputs[0]!))
    steps.push(group.title === undefined ? { key: 'rest', title: 'Everything else', inputs: group.inputs, target: false } : { key: `section:${place}`, title: group.title, ...(group.description ? { description: group.description } : {}), inputs: group.inputs, target: false })
  }
  return steps
}

/**
 * The line under an option of an entity or a person input: the fields its
 * `show` names, each as a grid cell says it, under the name its blueprint
 * gives it. A field the entity does not hold is left out, which is every
 * field the reader may not read: the hub never sent it.
 */
export function optionLine(e: Pick<Entity, 'fields'>, show: readonly string[] | undefined, blueprint: Pick<Blueprint, 'fields'> | undefined): string | undefined {
  const parts = (show ?? []).flatMap((name) => {
    const said = short(e.fields[name])
    return said ? [`${blueprint?.fields[name]?.title ?? name}: ${said}`] : []
  })
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * The inputs a run's page lists, in the order the form asked: what the form
 * asked for that run, read from what the run stored, so an input its `when`
 * left out is not there. An input the action no longer defines comes last.
 * With the action gone, everything the run stored.
 */
export function ranInputs(inputs: Record<string, ActionInputDef> | undefined, stored: Record<string, unknown>): [string, unknown][] {
  if (!inputs) return Object.entries(stored)
  const asked = askedInputs(inputs, stored, { stored: true }).asked.filter((name) => name in stored)
  return [...asked.map((name): [string, unknown] => [name, stored[name]]), ...Object.entries(stored).filter(([name]) => !(name in inputs))]
}
