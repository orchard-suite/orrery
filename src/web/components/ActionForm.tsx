// The form an action is run from, built from its inputs. Every option is
// rendered over the same scope the hub will render it over, so what the form
// offers is what the hub accepts. An input below one that changed renders
// again with the new scope. Each kind of input is drawn by the control
// `CONTROLS` names for it, and held to the same check the hub makes, from the
// registry of kinds: what the hub would refuse is said at the input first.
// Which inputs are asked, and what a worked-out one holds, is `askedInputs`,
// the decision the hub makes at the request: an input not asked is not drawn
// and never sent, and a worked-out one is shown, never sent.

import { ArrowLeft, ArrowRight, CalendarClock, Play, Plus, TriangleAlert, X } from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react'
import { narrowValue } from '../../shared/action-spec.ts'
import { askedInputs, formSections, type FormSection } from '../../shared/asked.ts'
import { checkInput, inputEmpty, kindOf, resolveDay } from '../../shared/input-kinds.ts'
import { changes, editsList, heldList, listChange, type ListChange } from '../../shared/list-change.ts'
import { actionTargets, entityIdFor, inputPicks, narrowingInputs, type Action, type ActionInputDef, type ActionInputType, type ActionRun, type ActionView, type Blueprint, type Entity, type Filter } from '../../shared/model.ts'
import { render, scopeEntity, type Scope } from '../../shared/template.ts'
import { failing, iconOf, inputShown, optionLine, usual, walkSteps, type Shown } from '../actions.ts'
import { CallError, useActionOptions, useActions, useActionTargets, useBlueprintName, useBlueprints, useRunAction, useWhoAmI } from '../api.ts'
import { Icon } from '../icons.tsx'
import { track } from '../telemetry.ts'
import { ACTION_FORM_OPENED } from '../../shared/usage.ts'
import { pasteRows, rowProblem, rowsValue, rowTexts, startList, type ListRow } from '../list-rows.ts'
import { navigate } from '../router.ts'
import { Combobox, type ComboOption } from './Combobox.tsx'
import { Drawer } from './Drawer.tsx'
import { ListChangeView } from './ListChange.tsx'
import { ScheduleDrawer, startCadence } from './Schedules.tsx'
import type { ScheduleRequest, ScheduleTarget } from '../../shared/api.ts'
import { Button, ErrorNote, input } from './ui.tsx'

/** What the form holds for each input: the raw value, and for an entity input the entities picked, so the scope below it can read their fields. */
type Values = Record<string, { value: unknown; entities?: Entity[] }>

/** What a form starts from: the entity a run was on, by id, and the inputs it was given, as a run stores them. */
export interface RunStart {
  entity?: string | null
  inputs?: Record<string, unknown>
}

/** One thing the form will not send yet, and the field to go to for it. */
interface Problem {
  field: string
  /** What the summary at the top says. */
  message: string
  /** What the field itself says. */
  here: string
  /** Nothing was given, where something must be. Anything else is a value the input does not take. */
  missing: boolean
}

/** A sentence from what a check said: its first word gets a capital when it is a plain word, never when it is an id or a key. */
function sentence(text: string): string {
  return /^[a-z]+(\s|$)/.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text
}

/**
 * What the hub refused about one input the form asks, in words for that
 * input: the hub names the input, so the form says it there. Null for any
 * other failure, which is the whole form's.
 */
export function refusedInput(error: unknown, names: readonly string[]): { input: string; message: string } | null {
  if (!(error instanceof CallError) || !error.input || !names.includes(error.input)) return null
  const named = `Input "${error.input}"`
  if (error.message === `${named} is required`) return { input: error.input, message: 'This must be filled in' }
  return { input: error.input, message: sentence(error.message.startsWith(`${named}: `) ? error.message.slice(named.length + 2) : error.message) }
}

/** An enum with more values than this is searched, not scrolled. */
const SEARCH_FROM = 8

/**
 * The form for one action. With `entity`, the action runs on it; an action
 * on a blueprint shown without one asks for the entity: first the inputs
 * that narrow it, then the entity from what the reader may run it on, then
 * the rest. Run on an entity, an input that narrows it is filled from it. An
 * action that waits for approval, there or on the entity picked, or asks to
 * be confirmed shows what was filled in before it is sent. On success the
 * page moves to the run. A `preview` form does everything but send. Above
 * the questions it says what the action's runs say of it: that it is
 * failing, and how long it usually takes.
 *
 * A value an input does not take is said at the input once the person leaves
 * it, and for every input when the form is sent; an input the form started
 * with is checked from the start. What the hub refuses about one input is
 * said there too, and the input takes the focus.
 *
 * An input with a `when` is drawn while the answers above it match, and one
 * with a `value` is shown as it is worked out. The action's sections are
 * headings over their inputs; with `walk`, the form shows one section at a
 * time as a step, each checked before the next, and the last step sends.
 *
 * With `onMany`, the form is filled once for many entities, a batch: it picks
 * no target, asks no input that narrows one (each entity fills its own), and
 * hands what it holds to `onMany` in place of running.
 */
export function ActionForm({ action, entity, start, layout = 'page', preview = false, onCancel, onChanged, onDone, onMany, later }: { action: Shown; entity?: Entity | null; start?: RunStart; layout?: 'page' | 'drawer'; preview?: boolean; onCancel?: () => void; /** Told whether the person has changed what the form started with. */ onChanged?: (changed: boolean) => void; /** Given the run that was asked for and the inputs as the form sent them, in place of opening the run. */ onDone?: (run: ActionRun, sent: Record<string, unknown>) => void; /** Given the inputs as the form would send them, for a batch, in place of running. */ onMany?: (inputs: Record<string, unknown>) => void; /** What running it later runs on, and is called: by default what the form runs on. Null offers no later. */ later?: { target: ScheduleTarget; title: string } | null }) {
  const blueprints = useBlueprints()
  const blueprintName = useBlueprintName()
  const me = useWhoAmI()
  const run = useRunAction()
  const formId = useId()
  useEffect(() => {
    if (!preview) track(ACTION_FORM_OPENED, { action: action.id, layout })
  }, [action.id, layout, preview])
  const failingNote = failing(action)
  const usualNote = usual(action)
  const targets = actionTargets(action)
  const onTarget = targets.length > 0
  const many = !!onMany
  // The entity it runs on, or until its options load, the id a form started from.
  const [pick, setPick] = useState<Entity | string | null>(entity ?? start?.entity ?? null)
  const given = () => Object.entries(start?.inputs ?? {}).filter(([, v]) => v !== null && v !== undefined)
  const [values, setValues] = useState<Values>(() => Object.fromEntries(given().map(([k, v]) => [k, { value: v }])))
  // The inputs whose value is held to its rules already: those the form started with, and those the person has left.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set(given().map(([k]) => k)))
  // The input the hub refused, until it has the focus.
  const [focusAt, setFocusAt] = useState<string | null>(null)
  // The blueprint a person input picks from, as the hub says it.
  const people = useActions().data?.person ?? null
  // The day it is in UTC: what `today` in a rule means, here as in the hub.
  const today = new Date().toISOString().slice(0, 10)
  const [checked, setChecked] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // Ticked in the review of a change to a list: the person says it is what they want.
  const [meant, setMeant] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  // The step a walked form is on: by its key, and by its place for when that step is gone.
  const [at, setAt] = useState<{ key: string; index: number }>({ key: '', index: 0 })
  const summary = useRef<HTMLDivElement>(null)
  const review = useRef<HTMLHeadingElement>(null)
  const stepHeading = useRef<HTMLHeadingElement>(null)
  // True from a move between steps until the step's heading has the focus. A step that comes or goes as a value changes never takes it.
  const moved = useRef(false)
  const bpOf = (id: string | undefined): Blueprint | undefined => blueprints.data?.blueprints.find((b) => b.id === id)
  const names = Object.keys(action.inputs)
  const narrowing = narrowingInputs(action)
  const target = pick && typeof pick === 'object' ? pick : null
  const targetId = typeof pick === 'string' ? pick : (pick?.id ?? null)
  // What the form fills by itself (a default, the one entity on offer) is where it starts: only what moves after the person first acts is theirs.
  const holding = JSON.stringify([targetId, Object.entries(values).map(([k, v]) => [k, v.value])])
  const acted = useRef(false)
  const first = useRef(holding)
  if (!acted.current) first.current = holding
  const changed = holding !== first.current
  const act = () => {
    acted.current = true
  }
  useEffect(() => onChanged?.(changed), [changed, onChanged])
  // What the reader may run it on, narrowed by what was answered above the pick.
  const narrow = Object.fromEntries(narrowing.flatMap((n) => (inputEmpty(action.inputs[n]!, values[n]?.value) ? [] : [[n, values[n]!.value]])))
  // What the hub says of the one target picked: whether its run waits for approval, and the entity a target given by id is.
  const known = useActionTargets(action.id, narrow, { of: targetId ?? undefined }, onTarget && !preview && !!targetId)
  useEffect(() => {
    if (typeof pick === 'string' && known.data) setPick(known.data.entities[0] ?? null)
  }, [pick, known.data])
  // Once the target is known, an input that narrows it is what the target holds.
  const held = (name: string): unknown => (target ? narrowValue(target, action.inputs[name]!) : undefined)
  const valueOf = (name: string): unknown => (target && narrowing.includes(name) ? held(name) : values[name]?.value)
  const waits = !!action.approval || (!!targetId && !!known.data?.approval.includes(targetId))
  // Which inputs are asked for what the form holds, and what each worked-out one holds: the hub's own decision.
  const play = askedInputs(action.inputs, Object.fromEntries(names.map((n) => [n, valueOf(n)])))
  const inPlay = new Set(play.asked)
  // The inputs that change a list the entity holds: the run is checked against that list before it is sent, whatever the action says.
  const lists = names.filter((n) => inPlay.has(n) && editsList(action.inputs[n]))
  // A batch is confirmed on what it runs on, after the form.
  const asks = !many && (waits || !!action.confirm || lists.length > 0)
  const worked = (name: string): boolean => action.inputs[name]!.value !== undefined
  /** What an input holds as the hub will read it: worked out, taken from the target, or given. */
  const holds = (name: string): unknown => (worked(name) ? play.values[name] : valueOf(name))
  // The scope grows input by input: each one sees the entity and every input above it.
  const scopes = useMemo(() => {
    const base: Scope = { action: { id: action.id, title: action.title }, entity: target ? scopeEntity(target, bpOf(target.blueprint)) : null, inputs: {}, run: { id: '', url: '', at: '' }, by: { name: me.data?.identity.name ?? '', ...(me.data?.address ? { address: me.data.address } : {}) } }
    const out: Scope[] = []
    const inputs: Record<string, unknown> = {}
    for (const name of names) {
      out.push({ ...base, inputs: { ...inputs } })
      // An input not asked holds nothing for the ones below it, whatever was typed into it while it was.
      if (!inPlay.has(name)) {
        inputs[name] = action.inputs[name]!.many ? [] : null
        continue
      }
      const v = values[name]
      const shaped = worked(name) || (target && narrowing.includes(name)) ? undefined : v?.entities?.map((e) => scopeEntity(e, bpOf(e.blueprint)))
      inputs[name] = shaped ? (action.inputs[name]!.many ? shaped : (shaped[0] ?? null)) : (holds(name) ?? null)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, target, values, blueprints.data, me.data])
  /** What an input that changes a list does to the list the entity holds now, as the form holds it. */
  const changeOf = (name: string): ListChange => {
    const def = action.inputs[name]!
    const scope = scopes[names.indexOf(name)]!
    const judged = checkInput(def, holds(name), { today })
    return listChange(heldList(def, render(def.current, scope)), judged.ok && Array.isArray(judged.value) ? judged.value : [])
  }
  const fieldId = (name: string) => `${formId}-${name}`
  const targetField = `${formId}-target`
  const targetLabel = targets.map((b) => blueprintName(b)).join(' or ')
  const labelOf = (name: string) => text(render(action.inputs[name]!.title ?? name, scopes[names.indexOf(name)]!))
  const rest = names.filter((n) => !narrowing.includes(n) && inPlay.has(n))
  // Until the entity is picked only what narrows it is asked for.
  const asked = many ? rest : onTarget && !target ? (entity ? [] : narrowing) : rest
  /** Why the hub would refuse what an input holds, by the check the hub makes, or null. Whether an entity exists is the hub's to say. */
  const wrong = (name: string): string | null => {
    const def = action.inputs[name]!
    const offered = kindOf(def.type).picks === 'values' ? render(def.values, scopes[names.indexOf(name)]!) : null
    const picks = inputPicks(def, people)
    const judged = checkInput(def, holds(name), { today, allowed: Array.isArray(offered) ? offered.map(String) : [], ...(picks.length ? { picks } : {}) })
    return judged.ok ? null : sentence(judged.error)
  }
  const problems: Problem[] = [
    ...asked.flatMap((n): Problem[] => {
      const def = action.inputs[n]!
      const label = labelOf(n)
      if (inputEmpty(def, holds(n))) return def.required ? [{ field: fieldId(n), message: `Fill in ${label}`, here: `Fill in ${label}`, missing: true }] : []
      const error = wrong(n)
      return error ? [{ field: fieldId(n), message: `${label}: ${error}`, here: error, missing: false }] : []
    }),
    ...(onTarget && !target && !many ? [{ field: targetField, message: `Pick the ${targetLabel} it runs on`, here: `Pick the ${targetLabel} it runs on`, missing: true }] : []),
  ]
  // A run that leaves every list as it is changes nothing, and the hub refuses it: said at the first list, as the hub says it.
  const still = lists.filter((n) => asked.includes(n))
  if (still.length && !problems.some((p) => still.some((n) => p.field === fieldId(n))) && still.every((n) => !changes(changeOf(n)))) {
    problems.push({ field: fieldId(still[0]!), message: `${labelOf(still[0]!)}: nothing would change`, here: 'This is the list as it is now, so nothing would change', missing: false })
  }
  const refused = refusedInput(run.error, asked)
  /** What a field says is wrong: what the hub refused, what is missing once the form was sent, and a value it does not take as soon as the person has left it. */
  const errorAt = (field: string, name?: string): string | null => {
    if (name && refused?.input === name) return refused.message
    const p = problems.find((p) => p.field === field)
    if (!p) return null
    // What is wrong with a worked-out value is nobody's to leave: it is said as it is worked out.
    return checked || (!p.missing && !!name && (touched.has(name) || worked(name))) ? p.here : null
  }
  // A walked form takes its sections as steps, when there is more than one to take.
  const steps = action.walk ? walkSteps(action, rest, onTarget && !entity && !many ? 'What it runs on' : null) : []
  const walking = steps.length > 1
  const found = steps.findIndex((s) => s.key === at.key)
  const stepIndex = found >= 0 ? found : Math.min(at.index, steps.length - 1)
  const step = walking ? steps[stepIndex]! : null
  const lastStep = !walking || stepIndex === steps.length - 1
  /** The step that holds a field, or -1. */
  const stepOf = (fieldAt: string): number => steps.findIndex((s) => (s.target ? fieldAt === targetField || narrowing.some((n) => fieldId(n) === fieldAt) : s.inputs.some((n) => fieldId(n) === fieldAt)))
  // On a step, what stops the form is what is wrong on that step.
  const stopping = walking ? problems.filter((p) => stepOf(p.field) === stepIndex) : problems
  const go = (index: number) => {
    moved.current = true
    setAt({ key: steps[index]!.key, index })
  }

  useEffect(() => {
    if (reviewing) review.current?.focus()
  }, [reviewing])
  // A move to another step puts the focus on its heading, which says which step of how many it is.
  useEffect(() => {
    if (!moved.current || reviewing) return
    moved.current = false
    if (!focusAt) stepHeading.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.key, reviewing])
  useEffect(() => {
    if (!focusAt || reviewing) return
    document.getElementById(fieldId(focusAt))?.focus()
    setFocusAt(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt, reviewing])

  // What is sent is what was asked: nothing for an input not asked, whatever it held, nothing for one the hub works out, and for many, nothing each one fills itself.
  const sentInputs = () => Object.fromEntries(names.filter((n) => inPlay.has(n) && !worked(n) && !(many && narrowing.includes(n))).map((n) => [n, valueOf(n) ?? null]))
  const [scheduling, setScheduling] = useState<ScheduleRequest | null>(null)
  // Set while the form is checked to be run later, not now: what it holds is checked as for a run, then handed to the schedule drawer.
  const deferring = useRef(false)
  const send = () => {
    if (preview) return setPreviewed(true)
    const inputs = sentInputs()
    if (deferring.current) {
      deferring.current = false
      const own = { target: target ? { entity: { blueprint: target.blueprint, key: target.key } } : {}, title: target ? `${action.title} on ${target.title}` : action.title }
      const { target: on, title } = later ?? own
      return setScheduling({ action: action.id, title, target: on, inputs, cadence: startCadence() })
    }
    if (onMany) return onMany(inputs)
    run.mutate(
      { id: action.id, entity: target ? { blueprint: target.blueprint, key: target.key } : undefined, inputs },
      {
        onSuccess: (r) => (onDone ? onDone(r, inputs) : navigate({ page: 'action-run', id: r.id })),
        // What the hub refused about one input is shown at it: back from the review, and to that input.
        onError: (error) => {
          const at = refusedInput(error, asked)
          if (!at) return
          setReviewing(false)
          const holding = stepOf(fieldId(at.input))
          if (walking && holding >= 0) setAt({ key: steps[holding]!.key, index: holding })
          setFocusAt(at.input)
        },
      },
    )
  }
  const submit = () => {
    setPreviewed(false)
    // A step before the last is checked by itself, then the form goes on.
    if (walking && !reviewing && !lastStep && !stopping.length) {
      setChecked(false)
      return go(stepIndex + 1)
    }
    setChecked(true)
    if (stopping.length || problems.length) {
      deferring.current = false
      // On the last step, what is wrong on another step is fixed there.
      const holding = stopping.length ? stepIndex : stepOf(problems[0]!.field)
      if (walking && holding >= 0 && holding !== stepIndex) setAt({ key: steps[holding]!.key, index: holding })
      // The summary is drawn on this render; focus it on the next frame.
      requestAnimationFrame(() => summary.current?.focus())
      return
    }
    // Run later goes to its own drawer, which says what it will do; the review is for running now.
    if (asks && !reviewing && !deferring.current) {
      setMeant(false)
      return setReviewing(true)
    }
    send()
  }
  const field = (name: string) => {
    const i = names.indexOf(name)
    const def = action.inputs[name]!
    const scope = scopes[i]!
    // A narrowing input once the target is known shows what the target holds; it is not asked.
    if (target && narrowing.includes(name)) return <Fixed key={name} label={labelOf(name)} value={narrowTitle(target, def) ?? 'Not set'} />
    const hint = def.description ? text(render(def.description, scope)) : undefined
    // A worked-out input is shown as the hub will work it out, and read aloud when it moves. It is never asked.
    if (worked(name)) {
      const said = inputShown(def, play.values[name])
      return (
        <Field key={name} id={fieldId(name)} label={labelOf(name)} hint={hint} error={errorAt(fieldId(name), name)} optional mark="(worked out)">
          {(aria) => (
            <output id={aria.id} tabIndex={-1} aria-live="polite" aria-describedby={aria.describedBy} className={`block whitespace-pre-wrap break-words text-sm ${said ? 'text-ink-100' : 'text-ink-400'}`}>
              {said || 'Nothing yet'}
            </output>
          )}
        </Field>
      )
    }
    const set = (value: unknown, picked?: Entity[]) => {
      setValues((prev) => ({ ...prev, [name]: { value, entities: picked } }))
      // A different answer above the pick may rule the pick out: it is picked again.
      if (narrowing.includes(name) && !entity) setPick(null)
      // What the hub refused is no longer what the input holds.
      if (refused?.input === name) run.reset()
    }
    const left = () => setTouched((prev) => (prev.has(name) ? prev : new Set(prev).add(name)))
    return (
      <Field key={name} id={fieldId(name)} label={labelOf(name)} hint={hint} error={errorAt(fieldId(name), name)} optional={!def.required} group={groupOf(def)} onLeave={left}>
        {(aria) => <Input {...aria} name={name} label={labelOf(name)} def={def} scope={scope} picks={inputPicks(def, people)} today={today} value={values[name]?.value} onChange={set} />}
      </Field>
    )
  }

  /** One group of inputs: under its heading when it has one. A group after another is ruled off from it. */
  const group = (g: FormSection, i: number) => {
    if (g.title === undefined) return i === 0 ? <Fragment key="rest">{g.inputs.map(field)}</Fragment> : <div key="rest" className="space-y-5 border-t border-ink-800 pt-5">{g.inputs.map(field)}</div>
    const headingId = `${formId}-section-${i}`
    return (
      <div key={headingId} role="group" aria-labelledby={headingId} className={`space-y-5 ${i === 0 ? '' : 'border-t border-ink-800 pt-5'}`}>
        <div>
          <h3 id={headingId} className="text-base font-semibold text-ink-100">
            {g.title}
          </h3>
          {g.description && <p className="mt-0.5 text-[13px] text-ink-300">{g.description}</p>}
        </div>
        {g.inputs.map(field)}
      </div>
    )
  }
  /** The question of what the action runs on: what narrows it, then the pick. */
  const targetAsk = (
    <>
      {narrowing.map(field)}
      <Field id={targetField} label={targetLabel} hint="It runs on the one you pick, from those you may run it on." error={errorAt(targetField)} optional={false}>
        {(aria) => <TargetPick {...aria} action={action.id} narrow={narrow} enabled={!preview} value={pick} onPick={(e) => ((e?.id ?? null) !== targetId && setValues((prev) => Object.fromEntries(Object.entries(prev).filter(([n]) => narrowing.includes(n)))), setPick(e))} />}
      </Field>
    </>
  )

  const drawer = layout === 'drawer'
  const runLabel = waits ? 'Ask to run' : 'Run'
  const stepHeadingId = `${formId}-step`
  return (
    <form
      noValidate
      className={drawer ? 'flex min-h-full flex-col' : 'space-y-5'}
      onPointerDownCapture={act}
      onKeyDownCapture={(e) => e.key !== 'Escape' && e.key !== 'Tab' && act()}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className={drawer ? 'flex-1 space-y-5 px-5 py-5' : 'space-y-5'}>
        {checked && stopping.length > 0 && (
          <div ref={summary} tabIndex={-1} role="alert" aria-labelledby={`${formId}-problems`} className="rounded-sm border border-red-dim bg-red/5 px-4 py-3 outline-none">
            <h3 id={`${formId}-problems`} className="text-sm font-semibold text-red">
              {stopping.every((p) => p.missing) ? (stopping.length === 1 ? 'One thing is missing' : `${stopping.length} things are missing`) : stopping.length === 1 ? 'One thing to fix' : `${stopping.length} things to fix`}
            </h3>
            <ul className="mt-1.5 list-disc space-y-2 pl-5 text-sm">
              {stopping.map((p) => (
                <li key={p.field}>
                  <a href={`#${p.field}`} className="inline-block py-1 text-red underline underline-offset-2" onClick={(e) => (e.preventDefault(), document.getElementById(p.field)?.focus())}>
                    {p.message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(failingNote || usualNote) && (
          <div className="space-y-1 text-[13px]">
            {failingNote && (
              <p className="flex items-center gap-1.5 font-medium text-red">
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                <span className="sr-only">Warning: </span>
                {failingNote}
              </p>
            )}
            {usualNote && <p className="text-ink-400">{usualNote}</p>}
          </div>
        )}
        {reviewing ? (
          <Review heading={review} action={action} waits={waits} target={target} names={names.filter((n) => inPlay.has(n))} values={values} valueOf={holds} labelOf={labelOf} lists={lists} changeOf={changeOf} meant={meant} onMeant={setMeant} />
        ) : step ? (
          <div role="group" aria-labelledby={stepHeadingId} className="space-y-5">
            <div>
              <h3 id={stepHeadingId} ref={stepHeading} tabIndex={-1} className="text-base font-semibold text-ink-100 outline-none">
                <span className="block text-[13px] font-normal text-ink-300">
                  Step {stepIndex + 1} of {steps.length}
                </span>
                {step.title}
              </h3>
              {step.description && <p className="mt-0.5 text-[13px] text-ink-300">{step.description}</p>}
            </div>
            {stepIndex === 0 && onTarget && entity && narrowing.map(field)}
            {step.target ? targetAsk : step.inputs.map(field)}
          </div>
        ) : (
          <>
            {onTarget && !entity && !many && targetAsk}
            {onTarget && entity && narrowing.map(field)}
            {many && narrowing.length > 0 && <p className="text-sm text-ink-400">Each one fills in {narrowing.map(labelOf).join(' and ')} itself.</p>}
            {onTarget && !target && !many && rest.length > 0 && <p className="text-sm text-ink-400">The rest of the form follows what you pick.</p>}
            {(!onTarget || target || many) && formSections(action, rest).map(group)}
            {!names.length && !onTarget && <p className="text-sm text-ink-400">This action asks for nothing.</p>}
          </>
        )}
        <ErrorNote error={refused ? null : run.error} />
        {previewed && <p className="rounded-sm border border-ink-600 px-3 py-2 text-sm text-ink-300">This is a preview: nothing was sent.</p>}
      </div>
      <div className={drawer ? 'sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-ink-700 bg-ink-900 px-5 py-3' : 'flex flex-wrap items-center gap-2'}>
        {(reviewing || (walking && stepIndex > 0)) && (
          <Button
            onClick={() => {
              // Back from the review is back to the step it was sent from; back from a step is the step before.
              if (walking) moved.current = true
              if (reviewing) return setReviewing(false)
              setChecked(false)
              go(stepIndex - 1)
            }}
          >
            <span className="flex items-center gap-1.5">
              <ArrowLeft className="size-3" /> Back
            </span>
          </Button>
        )}
        <Button kind="solid" type="submit" disabled={run.isPending || (reviewing && lists.length > 0 && !meant)}>
          <span className="flex items-center gap-1.5">
            {!reviewing && !lastStep ? (
              <>
                Next <ArrowRight className="size-3" />
              </>
            ) : asks && !reviewing ? (
              'Review'
            ) : many ? (
              <>
                See what it runs on <ArrowRight className="size-3" />
              </>
            ) : (
              <>
                <Play className="size-3" /> {run.isPending ? 'Sending…' : runLabel}
              </>
            )}
          </span>
        </Button>
        {later !== null && !many && !preview && lastStep && !reviewing && (
          <Button
            opens="dialog"
            onClick={() => {
              deferring.current = true
              submit()
            }}
          >
            <span className="flex items-center gap-1.5">
              <CalendarClock className="size-3" /> Run later…
            </span>
          </Button>
        )}
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        {waits && <span className="text-[12px] text-ink-400">Someone else approves it before it runs.</span>}
      </div>
      {scheduling && <ScheduleDrawer request={scheduling} onClose={() => setScheduling(null)} />}
    </form>
  )
}

/** The title of what a narrowing input takes from the target: the entity it points at, or the field's value. */
function narrowTitle(target: Entity, def: ActionInputDef): string | null {
  if (kindOf(def.type).picks === 'entity') {
    const to = target.relations[def.narrows!]?.[0]
    return to ? (to.title ?? to.key) : null
  }
  const v = narrowValue(target, def)
  return v === null || v === undefined ? null : String(v)
}

/** A value the form shows but does not ask for. */
function Fixed({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-ink-100">{label}</p>
      <p className="text-sm text-ink-200" title="Taken from what it runs on">
        {value}
      </p>
    </div>
  )
}

/** The pick of what the action runs on, from what the hub says the reader may run it on. A single option is picked on its own. */
/** How long typing rests before the hub is asked what it matches. */
const SEARCH_REST_MS = 250

/** A value that follows the one given once it has stopped changing for a moment. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The pick of what an action runs on. The hub searches the targets as the person types and answers with the first page. */
function TargetPick({ id, describedBy, invalid, required, action, narrow, enabled, value, onPick }: Aria & { action: string; narrow: Record<string, unknown>; enabled: boolean; value: Entity | string | null; onPick: (e: Entity | null) => void }) {
  const [query, setQuery] = useState('')
  const q = useSettled(query.trim(), SEARCH_REST_MS)
  const found = useActionTargets(action, narrow, { q }, enabled)
  const options = found.data?.entities ?? []
  const picked = typeof value === 'string' ? value : value ? value.id : ''
  const blueprintName = useBlueprintName()
  const kinds = new Set(options.map((e) => e.blueprint)).size
  const everything = !q && !!found.data
  useEffect(() => {
    // The only target there is is picked for them.
    if (everything && !picked && found.data!.total === 1 && options.length === 1) onPick(options[0]!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data])
  const choice = (e: Entity): ComboOption => ({ id: e.id, label: e.title, detail: kinds > 1 ? blueprintName(e.blueprint) : e.title !== e.key ? e.key : undefined, note: found.data?.approval.includes(e.id) ? 'needs approval' : undefined })
  // Picking among several kinds, each option says which it is.
  const choices = options.map(choice)
  if (everything && !options.length) return <p className="text-sm text-ink-400">Nothing here you may run it on</p>
  return <Combobox id={id} describedBy={describedBy} invalid={invalid} required={required} options={choices} value={picked || null} loading={found.isLoading || query.trim() !== q} onQuery={setQuery} more={Math.max(0, (found.data?.total ?? 0) - options.length)} current={value && typeof value === 'object' ? choice(value) : null} onChange={(next) => onPick(options.find((o) => o.id === next) ?? null)} />
}

/**
 * What will be sent, to check before sending it. An input that changes a list
 * the entity holds shows the change against that list, and the person ticks
 * that it is what they want before it can be sent.
 */
export function Review({ heading, action, waits, target, names, values, valueOf, labelOf, lists, changeOf, meant, onMeant }: { heading: RefObject<HTMLHeadingElement | null>; action: Action; waits: boolean; target: Entity | null; names: string[]; values: Values; valueOf: (name: string) => unknown; labelOf: (name: string) => string; lists: string[]; changeOf: (name: string) => ListChange; meant: boolean; onMeant: (meant: boolean) => void }) {
  const shown = (name: string): string => {
    const def = action.inputs[name]!
    if (target && def.narrows) return narrowTitle(target, def) ?? 'Not set'
    const v = values[name]
    const value = valueOf(name)
    if (def.value === undefined && v?.entities?.length) return v.entities.map((e) => e.title).join(', ')
    return inputShown(def, value) || 'Not given'
  }
  return (
    <div className="space-y-3">
      <h3 ref={heading} tabIndex={-1} className="text-base font-semibold text-ink-100 outline-none">
        Check before you {waits ? 'ask' : 'run'}
      </h3>
      <dl className="divide-y divide-ink-800 rounded-sm border border-ink-700">
        {target && <Row label="Runs on" value={target.title} />}
        {names.map((n) =>
          lists.includes(n) ? (
            <div key={n} className="px-3 py-2 text-sm">
              <dt className="mb-1 text-ink-300">{labelOf(n)}</dt>
              <dd>
                <ListChangeView change={changeOf(n)} text={(v) => kindOf(action.inputs[n]!.type).text(v)} />
              </dd>
            </div>
          ) : (
            <Row key={n} label={labelOf(n)} value={shown(n)} />
          ),
        )}
      </dl>
      {waits && <p className="text-sm text-ink-300">The run waits until someone else approves it.</p>}
      {lists.length > 0 && (
        <label className="flex items-start gap-2 text-sm text-ink-200">
          <input type="checkbox" className="mt-0.5 size-4" checked={meant} onChange={(e) => onMeant(e.target.checked)} />
          <span>This is what I want</span>
        </label>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 px-3 py-2 text-sm">
      <dt className="w-40 shrink-0 text-ink-300">{label}</dt>
      <dd className="min-w-0 break-words text-ink-100">{value}</dd>
    </div>
  )
}

/** What a field hands its control so the label, the hint, and the error are read with it. */
interface Aria {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

/**
 * One question: its label, then the hint, then the error, then the control.
 * A field that is a set of checkboxes or of radio buttons is a fieldset, its
 * label the legend. A question that must be answered carries a mark, and
 * says so in words: on the control, or for a set of checkboxes, which has
 * nowhere else to say it, in its name. An error is words beside a mark, never
 * colour alone. `onLeave` is called when the focus leaves the question. A
 * field that is shown and not asked says which with `mark`, in place of
 * whether it must be answered.
 */
function Field({ id, label, hint, error, optional, mark, group = null, onLeave, children }: { id: string; label: string; hint?: string; error: string | null; optional: boolean; mark?: string; group?: Group; onLeave?: () => void; children: (aria: Aria) => ReactNode }) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const legendId = `${id}-legend`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined
  const title = (
    <>
      <span className="text-sm font-medium text-ink-100">{label}</span>
      {mark ? (
        <span className="ml-1.5 text-sm text-ink-400">{mark}</span>
      ) : optional ? (
        <span className="ml-1.5 text-sm text-ink-400">(optional)</span>
      ) : (
        <>
          <span aria-hidden="true" title="Required" className="ml-0.5 text-red">
            *
          </span>
          {(group === 'checks' || group === 'rows') && <span className="sr-only"> (required)</span>}
        </>
      )}
    </>
  )
  const rest = (
    <>
      {hint && (
        <p id={hintId} className="mb-1.5 text-[13px] text-ink-300">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mb-1.5 flex items-start gap-1.5 text-[13px] font-medium text-red">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="sr-only">Error: </span>
            {error}
          </span>
        </p>
      )}
      {children({ id, describedBy, invalid: !!error, required: !optional })}
    </>
  )
  const edge = error ? 'border-l-2 border-red pl-3' : ''
  // The question is left when the focus goes somewhere outside it.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) onLeave?.()
  }
  if (group) {
    // A set of radio buttons is one answer: the set says it is required and whether it holds an error.
    const one = group === 'radios' ? { role: 'radiogroup', 'aria-labelledby': legendId, 'aria-required': !optional || undefined, 'aria-invalid': !!error || undefined } : {}
    return (
      <fieldset {...one} aria-describedby={describedBy} className={edge} onBlur={onBlur}>
        <legend id={legendId} className="mb-1">
          {title}
        </legend>
        {rest}
      </fieldset>
    )
  }
  return (
    <div className={edge} onBlur={onBlur}>
      <label htmlFor={id} className="mb-1 block">
        {title}
      </label>
      {rest}
    </div>
  )
}

/** How an input's control is grouped: a set of checkboxes, a set of radio buttons, a box a row of a list, or one control. */
type Group = 'checks' | 'radios' | 'rows' | null

function groupOf(def: ActionInputDef): Group {
  const kind = kindOf(def.type)
  const buttons = kind.options.includes('display') && def.display === 'buttons'
  if (def.many) return kind.picks ? 'checks' : 'rows'
  return buttons ? 'radios' : null
}

/** What a control is handed: the input, the scope its templates render over, what it holds, and how the field names it. */
interface Ask extends Aria {
  name: string
  /** The input's title as the form shows it, for a control of several boxes to name each by. */
  label: string
  def: ActionInputDef
  scope: Scope
  /** The blueprints an input that picks an entity picks from. */
  picks: string[]
  /** The day it is in UTC, for a bound that reads `today`. */
  today: string
  value: unknown
  onChange: (value: unknown, entities?: Entity[]) => void
}

/** The attributes that tie a control to its field's label, hint, and error. */
type Attrs = { id: string; 'aria-describedby': string | undefined; 'aria-invalid': true | undefined; 'aria-required': true | undefined }
const attrs = ({ id, describedBy, invalid, required }: Aria): Attrs => ({ id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined, 'aria-required': required || undefined })
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The control each kind of input is asked with, for one value. A new kind in
 * the registry is a type error here until it has one. A kind that picks draws
 * its own list when it takes several; any other kind that takes several is
 * asked a row a value, by `ListEditor`.
 */
const CONTROLS: Record<ActionInputType, (ask: Ask) => ReactNode> = {
  string: (a) => <input {...attrs(a)} type="text" className={`${input} w-full`} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  text: (a) => <textarea {...attrs(a)} className={`${input} min-h-28 w-full`} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  markdown: (a) => <textarea {...attrs(a)} className={`${input} min-h-28 w-full font-mono text-[12px]`} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  attachment: (a) => <textarea {...attrs(a)} className={`${input} min-h-28 w-full font-mono text-[12px]`} spellCheck={false} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  // A statement a run was asked with before comes back as the object the hub keeps: it is shown as the JSON it was.
  change: (a) => <textarea {...attrs(a)} className={`${input} min-h-28 w-full font-mono text-[12px]`} spellCheck={false} value={a.value !== null && typeof a.value === 'object' ? JSON.stringify(a.value, null, 2) : textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  number: (a) => (
    <input
      {...attrs(a)}
      type="number"
      inputMode="decimal"
      className={`${input} w-full`}
      min={typeof a.def.min === 'number' ? a.def.min : undefined}
      max={typeof a.def.max === 'number' ? a.def.max : undefined}
      value={a.value === undefined || a.value === null ? '' : String(a.value)}
      onChange={(e) => a.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  ),
  boolean: (a) => (
    <div className="flex items-center gap-2 text-sm text-ink-200">
      <input {...attrs(a)} type="checkbox" className="size-4" checked={a.value === true} onChange={(e) => a.onChange(e.target.checked)} />
      <span aria-hidden>{a.value === true ? 'Yes' : 'No'}</span>
    </div>
  ),
  date: (a) => <input {...attrs(a)} type="date" className={`${input} w-full`} min={dayBound(a.def.min, a.today)} max={dayBound(a.def.max, a.today)} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} />,
  datetime: (a) => <Moment ask={a} />,
  email: (a) => <input {...attrs(a)} type="email" inputMode="email" className={`${input} w-full`} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} placeholder="name@example.com" />,
  url: (a) => <input {...attrs(a)} type="url" inputMode="url" className={`${input} w-full`} value={textOf(a.value)} onChange={(e) => a.onChange(e.target.value || undefined)} placeholder="https://" />,
  enum: (a) => <Choice ask={a} />,
  entity: (a) => <EntityAsk ask={a} />,
  person: (a) => <EntityAsk ask={a} />,
}

/** A bound of a date as the calendar takes it: the day it names today, or none. */
function dayBound(bound: number | string | undefined, today: string): string | undefined {
  return typeof bound === 'string' ? (resolveDay(bound, today) ?? undefined) : undefined
}

/**
 * One input, drawn by its kind. A default is rendered over the scope whenever the input
 * holds nothing and the default renders to something: for one entity, a relation's id, the
 * first of a list, or a bare key. A single entity input whose options come
 * to one entity picks it. A `many` input holds a list.
 */
function Input(ask: Ask) {
  const { name, def, scope, picks, value, onChange } = ask
  const kind = kindOf(def.type)
  // A list the entity holds is where an input that changes it starts, unless it says where else.
  const rendered = def.default === undefined ? startList(def, scope) : render(def.default, scope)
  // A bare key names an entity only when the input picks from one blueprint.
  const fallback = kind.picks === 'entity' && !def.many && rendered !== undefined ? (picks.length === 1 ? entityIdFor(rendered, picks[0]!) : typeof rendered === 'string' ? rendered : undefined) : rendered
  // A default that reads an input above this one fills in once that input
  // is answered; a value the person gave is never replaced.
  const fallbackKey = JSON.stringify(fallback ?? null)
  useEffect(() => {
    if (value === undefined && fallback !== undefined && fallback !== null) onChange(fallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, fallbackKey])
  if (def.many && !kind.picks) return <ListEditor ask={ask} />
  // A kind this page was not built with is asked as text, and the hub checks it.
  return ((CONTROLS as Record<string, (ask: Ask) => ReactNode>)[def.type] ?? CONTROLS.string)(ask)
}

/** How the keyboard of a phone is laid out for a row of each kind that takes a list. */
const ROW_MODE: Partial<Record<ActionInputType, 'text' | 'decimal' | 'email' | 'url'>> = { number: 'decimal', email: 'email', url: 'url' }
const ROW_HINT: Partial<Record<ActionInputType, string>> = { email: 'name@example.com', url: 'https://' }

/**
 * Several values of a kind that does not pick, a box a row. A row is checked
 * by the input's kind and rules as it is left, and a value already in an
 * earlier row is said there. A plus under the rows adds an empty one and
 * moves to it, and so does Enter in a row; each row has a remove button, shown
 * while the row is pointed at or holds the focus, always on a touch screen,
 * and reached by Tab like any. A paste of several lines is a row a line. The
 * form holds the rows that say something, each trimmed; an empty row is
 * dropped when it is sent. A row is a text box whatever its kind, so a paste
 * knows where the cursor is.
 */
function ListEditor({ ask }: { ask: Ask }) {
  const { def, value, onChange, today, label } = ask
  const held = rowTexts(value).join('\n')
  const ids = useRef(0)
  const made = (texts: string[]): ListRow[] => texts.map((text) => ({ id: ids.current++, text }))
  const [rows, setRows] = useState<ListRow[]>(() => made(rowTexts(value)))
  // The rows left once, by id: a row is held to its kind once the person has left it.
  const [left, setLeft] = useState<ReadonlySet<number>>(() => new Set())
  // What the form held after the last change here: anything else was put there from outside, such as a default or the list held now, and is shown.
  const typed = useRef(held)
  useEffect(() => {
    if (held === typed.current) return
    typed.current = held
    setRows(made(rowTexts(value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held])
  const boxes = useRef(new Map<number, HTMLInputElement>())
  const adder = useRef<HTMLButtonElement>(null)
  // Where the focus goes once the rows are drawn: a row by id, or the plus.
  const goTo = useRef<number | 'add' | null>(null)
  useEffect(() => {
    const to = goTo.current
    if (to === null) return
    goTo.current = null
    ;(to === 'add' ? adder.current : boxes.current.get(to))?.focus()
  })
  const commit = (next: ListRow[]) => {
    setRows(next)
    const sent = rowsValue(next.map((r) => r.text))
    typed.current = rowTexts(sent).join('\n')
    onChange(sent)
  }
  const leave = (...at: number[]) => setLeft((prev) => (at.every((id) => prev.has(id)) ? prev : new Set([...prev, ...at])))
  const addAfter = (index: number) => {
    const row = { id: ids.current++, text: '' }
    goTo.current = row.id
    commit([...rows.slice(0, index + 1), row, ...rows.slice(index + 1)])
  }
  const remove = (index: number) => {
    const rest = rows.filter((_, i) => i !== index)
    const next = rest.length ? rest : made([''])
    // The focus moves to the row that took its place, the one before it, or the plus when none is left to type in.
    goTo.current = rest.length ? next[Math.min(index, next.length - 1)]!.id : 'add'
    commit(next)
  }
  const texts = rows.map((r) => r.text)
  return (
    <div className="space-y-1.5">
      <ul className="space-y-1.5">
        {rows.map((row, i) => {
          const problem = left.has(row.id) ? rowProblem(def, texts, i, today) : null
          const errorId = `${ask.id}-row-${row.id}-error`
          const said = row.text.trim()
          return (
            <li key={row.id} className="group flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <input
                  ref={(el) => void (el ? boxes.current.set(row.id, el) : boxes.current.delete(row.id))}
                  id={i === 0 ? ask.id : `${ask.id}-row-${row.id}`}
                  type="text"
                  inputMode={ROW_MODE[def.type] ?? 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${label}, ${i + 1} of ${rows.length}`}
                  aria-describedby={[i === 0 ? ask.describedBy : undefined, problem ? errorId : undefined].filter(Boolean).join(' ') || undefined}
                  aria-invalid={problem || (i === 0 && ask.invalid) ? true : undefined}
                  aria-required={(i === 0 && ask.required) || undefined}
                  className={`${input} w-full font-mono text-[12px]`}
                  placeholder={ROW_HINT[def.type]}
                  value={row.text}
                  onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, text: e.target.value } : r)))}
                  onBlur={() => leave(row.id)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    leave(row.id)
                    addAfter(i)
                  }}
                  onPaste={(e) => {
                    const pasted = pasteRows(texts, i, e.clipboardData.getData('text'), e.currentTarget.selectionStart, e.currentTarget.selectionEnd)
                    if (!pasted) return
                    e.preventDefault()
                    const count = pasted.texts.length - rows.length + 1
                    const placed = pasted.texts.slice(i, i + count).map((text, j) => ({ id: j === 0 ? row.id : ids.current++, text }))
                    goTo.current = placed[placed.length - 1]!.id
                    leave(...placed.map((r) => r.id))
                    commit([...rows.slice(0, i), ...placed, ...rows.slice(i + 1)])
                  }}
                />
                {problem && (
                  <p id={errorId} className="mt-1 flex items-start gap-1.5 text-[13px] font-medium text-red">
                    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="sr-only">Error: </span>
                      {problem}
                    </span>
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={said ? `Remove ${said}` : `Remove row ${i + 1}`}
                title="Remove"
                onClick={() => remove(i)}
                className="btn btn-ghost size-8 shrink-0 justify-center p-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          )
        })}
      </ul>
      <button ref={adder} type="button" className="btn btn-ghost" onClick={() => addAfter(rows.length - 1)}>
        <span className="flex items-center gap-1.5">
          <Plus aria-hidden className="size-3" /> Add another
        </span>
      </button>
    </div>
  )
}

/** A moment, asked for on the reader's own clock and held as the instant it is, in UTC. */
function Moment({ ask }: { ask: Ask }) {
  const zoneId = `${ask.id}-zone`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <>
      <input
        {...attrs(ask)}
        aria-describedby={[ask.describedBy, zoneId].filter(Boolean).join(' ')}
        type="datetime-local"
        className={`${input} w-full`}
        value={localOf(ask.value)}
        onChange={(e) => {
          const at = new Date(e.target.value)
          ask.onChange(e.target.value && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined)
        }}
      />
      <p id={zoneId} className="mt-1 text-[12px] text-ink-400">
        In your own time{zone ? `, ${zone}` : ''}.
      </p>
    </>
  )
}

/** An instant as a `datetime-local` control holds it: the reader's own clock, to the minute. Nothing for what is not an instant. */
function localOf(value: unknown): string {
  const at = typeof value === 'string' && value ? new Date(value) : null
  if (!at || Number.isNaN(at.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`
}

/** A choice among rendered values: one of them or several, as a list or as buttons. */
function Choice({ ask }: { ask: Ask }) {
  const { def, scope, value, onChange } = ask
  const rendered = render(def.values, scope)
  const options = Array.isArray(rendered) ? rendered.map(String) : []
  const buttons = def.display === 'buttons'
  if (def.many) {
    const picked = Array.isArray(value) ? value.map(String) : []
    const change = (next: string[]) => onChange(next.length ? next : undefined)
    return buttons ? <ChoiceButtons id={ask.id} options={options} picked={picked} many required={ask.required} onChange={change} /> : <Checks id={ask.id} options={options} picked={picked} onChange={change} />
  }
  const one = textOf(value)
  if (buttons) return <ChoiceButtons id={ask.id} options={options} picked={one ? [one] : []} many={false} required={ask.required} onChange={(next) => onChange(next[0])} />
  return <EnumPick aria={attrs(ask)} options={options} value={one} onChange={onChange} />
}

/** An entity, or several, of the blueprints an input picks from. */
function EntityAsk({ ask }: { ask: Ask }) {
  const { def, scope, picks, value, onChange } = ask
  if (kindOf(def.type).person && !picks.length) return <p className="text-sm text-ink-400">The estate does not say who a person is, so there is nobody to pick.</p>
  const where = def.where ? (render(def.where, scope) as Filter) : undefined
  const current = def.current ? currentOf(render(def.current, scope)) : []
  if (def.many) {
    return <EntityChecks id={ask.id} blueprints={picks} where={where} sort={def.sort} show={def.show} current={current} picked={Array.isArray(value) ? value.map(String) : []} onPick={(es) => onChange(es.length ? es.map((e) => e.id) : undefined, es)} />
  }
  return <EntityPick id={ask.id} describedBy={ask.describedBy} invalid={ask.invalid} required={ask.required} blueprints={picks} where={where} sort={def.sort} show={def.show} current={current} value={typeof value === 'string' ? value : null} onPick={(e) => onChange(e ? e.id : undefined, e ? [e] : undefined)} lone />
}

/** Lets go of the picks the options no longer hold, each time the options change, so a stale pick never reaches the hub. */
function useKept(options: string[], picked: string[], onChange: (kept: string[]) => void): void {
  const key = options.join('\n')
  useEffect(() => {
    const kept = picked.filter((p) => options.includes(p))
    if (kept.length !== picked.length) onChange(kept)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/**
 * A few values drawn as buttons: radio buttons for one, checkboxes for
 * several. Each is a real input inside its label, so the keyboard works the
 * set as it does any, and what is picked is the input's own mark, not a
 * colour. One answer that need not be given can be taken back.
 */
function ChoiceButtons({ id, options, picked, many, required, onChange }: { id: string; options: string[]; picked: string[]; many: boolean; required: boolean; onChange: (next: string[]) => void }) {
  useKept(options, picked, onChange)
  if (!options.length) return <p className="text-sm text-ink-400">Nothing to pick from yet</p>
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((o, i) => {
        const on = picked.includes(o)
        return (
          <label key={o} className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${on ? 'border-orbit bg-orbit/10 text-ink-100' : 'border-edge text-ink-200 hover:bg-ink-800'}`}>
            <input id={i === 0 ? id : undefined} type={many ? 'checkbox' : 'radio'} name={id} value={o} checked={on} onChange={(e) => onChange(many ? (e.target.checked ? [...picked, o] : picked.filter((p) => p !== o)) : [o])} className="size-4 shrink-0" />
            <span className="break-all">{o}</span>
          </label>
        )
      })}
      {!many && !required && picked.length > 0 && <Button onClick={() => onChange([])}>Clear</Button>}
    </div>
  )
}

/** A pick over rendered values: a select for a few, a search for many. A value the new options do not hold is let go, so a stale pick never reaches the hub. */
function EnumPick({ aria, options, value, onChange }: { aria: Attrs; options: string[]; value: string; onChange: (value: unknown) => void }) {
  useKept(options, value ? [value] : [], () => onChange(undefined))
  if (options.length > SEARCH_FROM) {
    return <Combobox id={aria.id} describedBy={aria['aria-describedby']} invalid={!!aria['aria-invalid']} required={!!aria['aria-required']} options={options.map((o) => ({ id: o, label: o }))} value={value || null} onChange={(v) => onChange(v ?? undefined)} />
  }
  return (
    <select {...aria} className={`${input} w-full`} value={value} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{options.length ? 'Pick one' : 'Nothing to pick from yet'}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

/** Checkboxes over rendered values. A pick the new options no longer hold is let go. */
function Checks({ id, options, picked, onChange }: { id: string; options: string[]; picked: string[]; onChange: (next: string[]) => void }) {
  useKept(options, picked, onChange)
  if (!options.length) return <p className="text-sm text-ink-400">Nothing to pick from yet</p>
  return (
    <CheckList id={id} items={options.map((o) => ({ id: o, label: o, mono: true }))} picked={picked} onToggle={(o, on) => onChange(on ? [...picked, o] : picked.filter((p) => p !== o))} />
  )
}

/** Checkboxes over the entities of the blueprints an input picks from that a filter takes. */
function EntityChecks({ id, blueprints, where, sort, show, current = [], picked, onPick }: { id: string; blueprints: string[]; where: Filter | undefined; sort?: string; show?: string[]; current?: string[]; picked: string[]; onPick: (es: Entity[]) => void }) {
  const found = useActionOptions(blueprints, where, sort)
  const lineOf = useOptionLine(show)
  const options = found.data?.entities ?? []
  // A pick the options no longer hold is let go; a pick given by id, as a run again is, gets its entity.
  useEffect(() => {
    if (found.data && picked.length) onPick(options.filter((e) => picked.includes(e.id)))
    // Again when the picks change, so picks a default gives after cached options load get their entities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data, picked.join('\n')])
  if (found.isLoading) return <p className="text-sm text-ink-400">Loading…</p>
  if (!options.length) return <p className="text-sm text-ink-400">Nothing to pick from</p>
  return (
    <CheckList
      id={id}
      items={options.map((e) => ({ id: e.id, label: e.title, line: lineOf(e), detail: e.title !== e.key ? e.key : undefined, note: inUse(e, current) ? 'running now' : undefined }))}
      picked={picked}
      onToggle={(eid, on) => onPick(options.filter((o) => (o.id === eid ? on : picked.includes(o.id))))}
    />
  )
}

/** A list of checkboxes. A long one gets a box to narrow it; what is ticked stays ticked when it is narrowed out of sight. */
function CheckList({ id, items, picked, onToggle }: { id: string; items: { id: string; label: string; line?: string; detail?: string; note?: string; mono?: boolean }[]; picked: string[]; onToggle: (id: string, on: boolean) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.line?.toLowerCase().includes(q) || i.detail?.toLowerCase().includes(q)) : items
  return (
    <div className="space-y-2">
      {items.length > SEARCH_FROM && <input id={id} type="search" aria-label="Narrow the list" placeholder={`Search ${items.length}`} className={`${input} w-full`} value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((item, i) => (
          <label key={item.id} className="flex min-h-7 cursor-pointer items-start gap-2 rounded-sm px-1 py-1 text-sm text-ink-200 hover:bg-ink-800">
            <input id={i === 0 && items.length <= SEARCH_FROM ? id : undefined} type="checkbox" className="mt-0.5 size-4 shrink-0" checked={picked.includes(item.id)} onChange={(e) => onToggle(item.id, e.target.checked)} />
            {/* Items often differ only at the end, such as a version, so nothing is cut: the label and the detail each wrap. */}
            <span className="min-w-0 flex-1">
              <span className={`block break-all ${item.mono ? 'font-mono text-[12px]' : ''}`}>{item.label}</span>
              {item.line && <span className="block break-words text-[13px] text-ink-300">{item.line}</span>}
              {item.detail && <span className="block break-all font-mono text-[12px] text-ink-400">{item.detail}</span>}
            </span>
            {item.note && <span className="shrink-0 font-mono text-[10px] text-green">{item.note}</span>}
          </label>
        ))}
        {!shown.length && <p className="px-1 text-sm text-ink-400">Nothing matches</p>}
      </div>
      {picked.length > 0 && <p className="text-[12px] text-ink-400">{picked.length} picked</p>}
    </div>
  )
}

/** The line of `show` fields under an option, each named as its blueprint names it. */
function useOptionLine(show: string[] | undefined): (e: Entity) => string | undefined {
  const blueprints = useBlueprints()
  return (e) => optionLine(e, show, blueprints.data?.blueprints.find((b) => b.id === e.blueprint))
}

/** The values an input's `current` template rendered to, as text: one, or each of a list. */
function currentOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined).map(String)
}

/** True when an option is the one in use now: its id, key, or title is among the current values. */
function inUse(e: Entity, current: string[]): boolean {
  return current.includes(e.id) || current.includes(e.key) || current.includes(e.title)
}

/** A rendered title or hint as text: a template that gives a list or an object is written as JSON. */
function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * A search over the entities of the blueprints an input picks from that a filter takes. A pick
 * given by id gets its entity once the options load. With `lone`, a single
 * option is picked on its own: an action meant for one entity asks nothing.
 */
function EntityPick({ id, describedBy, invalid, required, blueprints, where, sort, show, current = [], value, onPick, lone = false }: Aria & { blueprints: string[]; where: Filter | undefined; sort?: string; show?: string[]; current?: string[]; value: Entity | string | null; onPick: (e: Entity | null) => void; lone?: boolean }) {
  const found = useActionOptions(blueprints, where, sort)
  const lineOf = useOptionLine(show)
  const options = found.data?.entities ?? []
  const picked = typeof value === 'string' ? value : value ? value.id : ''
  useEffect(() => {
    if (!found.data) return
    const hit = options.find((e) => e.id === picked)
    if (picked && !hit) onPick(null)
    else if (hit && typeof value === 'string') onPick(hit)
    else if (!picked && lone && options.length === 1) onPick(options[0]!)
    // It runs again when the pick changes, not only when the options do: with
    // the options cached it runs before a default fills the pick in by id, and
    // that id must still get its entity, or the inputs below read no fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.data, picked])
  const choices: ComboOption[] = options.map((e) => ({ id: e.id, label: e.title, line: lineOf(e), detail: e.title !== e.key ? e.key : undefined, note: inUse(e, current) ? 'running now' : undefined }))
  return <Combobox id={id} describedBy={describedBy} invalid={invalid} required={required} options={choices} value={picked || null} loading={found.isLoading} onChange={(next) => onPick(options.find((o) => o.id === next) ?? null)} />
}

/** An action's form in a drawer: what it does, what it runs on, and the form. */
export function RunDrawer({ action, entity, start, onClose }: { action: Shown; entity?: Entity | null; start?: RunStart; onClose: () => void }) {
  const [changed, setChanged] = useState(false)
  return (
    <Drawer
      title={action.title}
      icon={<Icon name={iconOf(action)} className="size-6" />}
      subtitle={
        (action.description || entity) && (
          <>
            {action.description && <p>{action.description}</p>}
            {entity && <p className="mt-1 text-ink-400">On {entity.title}</p>}
          </>
        )
      }
      onClose={onClose}
      unsaved={changed}
    >
      <ActionForm action={action} entity={entity} start={start} layout="drawer" onCancel={onClose} onChanged={setChanged} />
    </Drawer>
  )
}

/**
 * The actions the person may run on an entity, as buttons; each opens its
 * form in a drawer. The hub says which, on the entity it reads: an action no
 * rule lets them run there is not there.
 */
export function EntityActions({ entity, size = 'md', except = [] }: { entity: Entity; size?: 'sm' | 'md'; except?: readonly string[] }) {
  const actions = useActions()
  const [open, setOpen] = useState<ActionView | null>(null)
  const mine = (actions.data?.actions ?? []).filter((a) => a.canRun && (entity.actions ?? []).includes(a.id) && !except.includes(a.id))
  if (!mine.length) return null
  const cls = size === 'sm' ? 'px-2 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'
  return (
    <>
      {mine.map((a) => (
        <button key={a.id} type="button" title={a.description ?? a.title} aria-haspopup="dialog" onClick={() => setOpen(a)} className={`flex items-center gap-1.5 rounded-md border border-orbit/60 bg-orbit/10 font-medium text-ink-100 hover:border-orbit hover:bg-orbit/20 ${cls}`}>
          <Icon name={iconOf(a)} className="size-3.5" />
          {a.title}
        </button>
      ))}
      {open && <RunDrawer action={open} entity={entity} onClose={() => setOpen(null)} />}
    </>
  )
}

/** The colour and the word for a run's state. */
export const RUN_STATE: Record<ActionRun['state'], string> = { awaiting: 'text-amber', queued: 'text-ink-300', running: 'text-orbit', succeeded: 'text-green', failed: 'text-red', unknown: 'text-amber', declined: 'text-ink-400', cancelled: 'text-ink-400', returned: 'text-amber' }
