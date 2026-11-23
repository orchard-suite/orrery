// The editor for an action's definition. The YAML is the one source: the
// Form tab reads it and writes each change back into it, keeping comments and
// whatever the form does not show. The definition is checked as it is typed,
// with the hub's own checks, and the form it makes is previewed beside it.
// What an input's form asks for is what the registry of kinds says its kind
// takes: its options, its rules, and how its default is given. What the form
// asks by (a `when`, a worked-out value, sections, the walk) is edited here
// too, and checked by the same checks.

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { isMap, isScalar, LineCounter, parseDocument, type Document, type YAMLMap } from 'yaml'
import { checkAction, type ActionSpec, type SpecIssue } from '../../shared/action-spec.ts'
import { INPUT_KINDS, INPUT_RULES, type InputKind, type InputOption, type InputRule } from '../../shared/input-kinds.ts'
import type { GridClause } from '../../shared/api.ts'
import { ACTION_INPUT_TYPES, entityId, ownsPaths, parseEntityId, SHOW_MAX, type Action, type ActionInputType, type Blueprint } from '../../shared/model.ts'
import { useAccessSettings, useActions, useBlueprintName, useBlueprints, useSaveAction, useWhoAmI } from '../api.ts'
import { draftSections, placed, renamedIn, sectionOfInput, sectionShifted, shifted, without, type SectionDraft } from '../builder.ts'
import { clausesOf, fieldRenamed, filterOf } from '../../shared/clauses.ts'
import { Icon } from '../icons.tsx'
import { navigate } from '../router.ts'
import { ActionForm } from './ActionForm.tsx'
import { Conditions } from './Clauses.tsx'
import { IconPicker } from './editors.tsx'
import { HomePicker, HomeRef } from './HomePicker.tsx'
import { Button, ErrorNote, input, Kicker, Panel, TabPanel, Tabs } from './ui.tsx'
import { useEscape } from '../layers.ts'

const TEMPLATE = `id: new_action
title: A new action
description: What it does and when to use it. Write this for a person and an agent.
icon: rocket
group: Operations
inputs:
  why:
    type: string
    title: Why
    required: true
backend:
  type: webhook
  url: https://hooks.example.org/new-action
`

type Path = (string | number)[]
type Raw = Record<string, unknown>

/** The tests a `when` may make of an input: every test but the ones that read the time, and the one that takes a list. */
const WHEN_OPS: readonly GridClause['op'][] = ['exists', 'eq', 'neq', 'contains', 'prefix', 'gt', 'gte', 'lt', 'lte']

/** An issue with the line of the YAML it is about. */
interface Located extends SpecIssue {
  line: number
}

const BACKENDS: { type: ActionSpec['backend']['type']; label: string; skeleton: Raw }[] = [
  { type: 'webhook', label: 'Webhook', skeleton: { type: 'webhook', url: 'https://' } },
  { type: 'github_workflow', label: 'GitHub workflow', skeleton: { type: 'github_workflow', owner: '', repo: '', workflow: '', secretRef: '' } },
  { type: 'runner', label: 'Runner', skeleton: { type: 'runner', runner: '', command: [] } },
  { type: 'job', label: 'A container for each run', skeleton: { type: 'job', starter: '', template: '', image: '' } },
  { type: 'record', label: 'Record an entity', skeleton: { type: 'record', source: '', blueprint: '', key: '{{ run.id }}' } },
  { type: 'caller', label: 'Done by whoever asks', skeleton: { type: 'caller' } },
  { type: 'decide', label: 'Decide one of the hub\'s approvals', skeleton: { type: 'decide', verdict: 'approve' } },
  { type: 'schedule', label: 'Pause, resume, or run one of the hub\'s schedules', skeleton: { type: 'schedule', verb: 'pause' } },
]

export function ActionEditor({ initial, id, onDone }: { initial?: string; id?: string; onDone: () => void }) {
  const save = useSaveAction()
  const blueprints = useBlueprints().data?.blueprints ?? []
  const admin = !!useWhoAmI().data?.identity.admin
  const actions = useActions().data
  const groups = [...new Set((actions?.actions ?? []).map((a) => a.group).filter((g): g is string => !!g))].sort()
  // The blueprint the estate says a person is: null when it says none, and unknown until the hub has answered.
  const people = actions?.person
  const [text, setText] = useState(initial ?? TEMPLATE)
  useEscape(onDone, text !== (initial ?? TEMPLATE))
  const [tab, setTab] = useState<'form' | 'yaml'>('form')
  const area = useRef<HTMLTextAreaElement>(null)
  const base = useId()

  const parsed = useMemo(() => {
    const lines = new LineCounter()
    const doc = parseDocument(text, { lineCounter: lines })
    if (doc.errors.length) return { raw: null, yamlErrors: doc.errors.map((e) => ({ line: e.linePos?.[0].line ?? 1, message: e.message.split('\n')[0]! })), issues: [] as Located[], spec: null }
    const js: unknown = doc.toJS()
    const raw: Raw = js && typeof js === 'object' && !Array.isArray(js) ? (js as Raw) : {}
    const checked = checkAction(id ? { ...raw, id } : raw, blueprints, people)
    return { raw, yamlErrors: [], issues: checked.issues.map((i) => ({ ...i, line: lineOf(doc, lines, i.path) })), spec: checked.spec }
  }, [text, id, blueprints, people])
  const problems: Located[] = [...parsed.yamlErrors.map((e) => ({ ...e, path: [] })), ...parsed.issues]

  /** Writes one change into the YAML. An empty value removes the key. */
  const change = (fn: (doc: Document) => void) => {
    const doc = parseDocument(text)
    if (doc.errors.length) return
    fn(doc)
    setText(String(doc))
  }
  const set = (path: Path, value: unknown) => change((doc) => (value === undefined || value === '' || value === false || (Array.isArray(value) && !value.length) ? doc.deleteIn(path) : doc.setIn(path, value)))
  const issueAt = (path: Path) => parsed.issues.find((i) => i.path.join('.') === path.join('.'))?.message

  const goTo = (line: number) => {
    setTab('yaml')
    requestAnimationFrame(() => {
      const el = area.current
      if (!el) return
      const start = text.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)
      el.focus()
      el.setSelectionRange(start, text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start))
    })
  }

  const submit = () => {
    if (!parsed.raw) return
    const target = id ?? String(parsed.raw.id ?? '')
    save.mutate({ id: target, spec: parsed.raw }, { onSuccess: () => (onDone(), navigate({ page: 'actions', id: target })) })
  }

  const preview: Action | null = parsed.spec && { ...parsed.spec, origin: { kind: 'ui' }, updatedAt: '' }
  const tabsId = `${base}-tabs`
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{id ? `Edit ${id}` : 'New action'}</h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-ink-400" aria-live="polite">
            {problems.length ? `${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix` : 'Ready to save'}
          </span>
          <Button kind="solid" onClick={submit} disabled={save.isPending || problems.length > 0}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      </div>
      <ErrorNote error={save.error} />
      {problems.length > 0 && (
        <Panel className="border-red-dim px-4 py-3">
          <h3 id={`${base}-problems`} className="text-sm font-semibold text-red">
            To fix before it saves
          </h3>
          <ul className="mt-1 space-y-0.5 text-sm">
            {problems.map((p, i) => (
              <li key={i}>
                <button type="button" onClick={() => goTo(p.line)} className="text-left text-red underline-offset-2 hover:underline">
                  Line {p.line}: {p.message}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel>
          <div className="border-b border-ink-800 px-4">
            <Tabs id={tabsId} label="How to edit" tabs={[{ id: 'form', label: 'Form' }, { id: 'yaml', label: 'YAML' }]} value={tab} onChange={setTab} />
          </div>
          <TabPanel id={tabsId} value={tab} className="p-4">
            {tab === 'yaml' ? (
              <div className="space-y-3">
                <textarea ref={area} aria-label="The action's definition, in YAML" aria-describedby={problems.length ? `${base}-problems` : undefined} className={`${input} min-h-[28rem] w-full font-mono text-[12px] leading-5`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
                <Reference />
              </div>
            ) : parsed.raw ? (
              <SpecForm raw={parsed.raw} fixedId={id} blueprints={blueprints} groups={groups} admin={admin} people={people} set={set} change={change} issueAt={issueAt} />
            ) : (
              <p className="text-sm text-ink-300">The YAML does not read yet. Fix it in the YAML tab, and the form comes back.</p>
            )}
          </TabPanel>
        </Panel>
        <Panel className="self-start px-5 py-4 xl:sticky xl:top-4">
          <h3 className="mb-1 text-base font-semibold text-ink-100">Preview</h3>
          <p className="mb-4 text-[13px] text-ink-400">The form a person fills in. Nothing it sends runs.</p>
          {preview ? <ActionForm key={JSON.stringify([preview.blueprint, preview.inputs, preview.sections, preview.walk])} action={preview} preview /> : <p className="text-sm text-ink-400">The preview shows once the definition has nothing to fix.</p>}
        </Panel>
      </div>
    </div>
  )
}

/** The line of the deepest node a path reaches, so an issue about a missing key points at its parent. */
function lineOf(doc: Document, lines: LineCounter, path: Path): number {
  for (let n = path.length; n >= 0; n--) {
    const node = n ? doc.getIn(path.slice(0, n), true) : doc.contents
    const range = node && typeof node === 'object' && 'range' in node ? (node.range as [number, number, number] | undefined) : undefined
    if (range) return lines.linePos(range[0]).line
  }
  return 1
}

/** The form over the parts of a definition most actions use. Anything else stays in the YAML untouched, and the form says where. */
function SpecForm({ raw, fixedId, blueprints, groups, admin, people, set, change, issueAt }: { raw: Raw; fixedId?: string; blueprints: Blueprint[]; groups: string[]; admin: boolean; people: string | null | undefined; set: (path: Path, value: unknown) => void; change: (fn: (doc: Document) => void) => void; issueAt: (path: Path) => string | undefined }) {
  const base = useId()
  const blueprintName = useBlueprintName()
  const [iconAnchor, setIconAnchor] = useState<HTMLElement | null>(null)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? (raw.inputs as Record<string, Raw>) : {}
  const names = Object.keys(inputs)
  const backend = (raw.backend && typeof raw.backend === 'object' ? raw.backend : {}) as Raw
  const access = (raw.access && typeof raw.access === 'object' ? raw.access : {}) as Raw
  // The ways a person owns something, as the person setting names them: what opening to a home's people may be narrowed to.
  const person = useAccessSettings().data?.person
  const homeWays = Array.isArray(access.home) ? access.home.map(String) : []
  const ways = [...new Set([...ownsPaths(person?.owns).flatMap((o) => (o.as ? [o.as] : [])), ...homeWays])]
  const setWay = (way: string, on: boolean) => {
    const next = on ? [...homeWays, way] : homeWays.filter((w) => w !== way)
    set(['access', 'home'], next.length ? next : true)
  }
  const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
  const targets = listOf(raw.blueprint).map((id) => blueprints.find((b) => b.id === id)).filter((b): b is Blueprint => !!b)
  /** The blueprints an input picks an entity from: those it names, or for a person, the one the estate says a person is. */
  const picksOf = (kind: InputKind, def: Raw): string[] => (kind.picks !== 'entity' ? [] : kind.person ? (people ? [people] : []) : listOf(def.blueprint))
  /** What an input may narrow on every blueprint it runs on: a relation to what an input that picks an entity picks from, or a field for any other. */
  const narrowOptions = (kind: InputKind, picks: string[]): string[] => {
    const named = targets.map((t) => (kind.picks === 'entity' ? Object.entries(t.relations).filter(([, r]) => picks.includes(r.target)).map(([n]) => n) : Object.keys(t.fields)))
    return named.length ? named.reduce((a, b) => a.filter((n) => b.includes(n))).sort() : []
  }
  /** Gives an input another kind. What the new kind does not take would be refused, so it goes with the old one. */
  const retype = (name: string, type: ActionInputType) =>
    change((doc) => {
      const kind = INPUT_KINDS[type]
      const at = (key: string) => ['inputs', name, key]
      doc.setIn(at('type'), type)
      for (const option of ['many', 'display', 'narrows', 'unique', 'show'] as const) if (!kind.options.includes(option)) doc.deleteIn(at(option))
      for (const rule of INPUT_RULES) if (!kind.rules.includes(rule)) doc.deleteIn(at(rule))
      // What is picked is never worked out.
      if (kind.picks) doc.deleteIn(at('value'))
      if (!INPUT_RULES.some((rule) => doc.hasIn(at(rule))) && !doc.hasIn(at('unique'))) doc.deleteIn(at('hint'))
    })

  const sections = draftSections(raw.sections)
  const setSections = (next: SectionDraft[] | null) => next && set(['sections'], next)
  const sectionName = (s: SectionDraft, i: number) => str(s.title) || `Section ${i + 1}`
  /** The inputs no section names, which the form asks last. One that narrows what the action runs on is asked first, and is in none. */
  const loose = names.filter((n) => sectionOfInput(sections, n) === null && !inputs[n]?.narrows)

  const inputsMap = (doc: Document) => doc.getIn(['inputs']) as YAMLMap | undefined
  /** Gives an input another name, and keeps it where it was: in its section, and in every `when` that tests it. */
  const rename = (from: string, to: string) =>
    change((doc) => {
      const pair = inputsMap(doc)?.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === from)
      if (!pair) return
      pair.key = doc.createNode(to)
      if (sectionOfInput(sections, from) !== null) doc.setIn(['sections'], renamedIn(sections, from, to))
      for (const [name, def] of Object.entries(inputs)) {
        const next = fieldRenamed(def.when, from, to)
        if (next !== def.when) doc.setIn(['inputs', name === from ? to : name, 'when'], next)
      }
    })
  /** Takes an input off the action, and out of its section. */
  const remove = (name: string) =>
    change((doc) => {
      doc.deleteIn(['inputs', name])
      if (sectionOfInput(sections, name) !== null) doc.setIn(['sections'], without(sections, name))
    })
  const move = (name: string, by: -1 | 1) =>
    change((doc) => {
      const map = inputsMap(doc)
      if (!isMap(map)) return
      const i = map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === name)
      const j = i + by
      if (i < 0 || j < 0 || j >= map.items.length) return
      const [pair] = map.items.splice(i, 1)
      map.items.splice(j, 0, pair!)
    })
  const add = () => {
    let n = names.length + 1
    while (inputs[`input_${n}`]) n++
    set(['inputs', `input_${n}`], { type: 'string', title: `Input ${n}` })
  }

  return (
    <div className="space-y-6">
      <Section title="About it">
        <Text label="Id" hint={fixedId ? 'An action keeps its id.' : 'Lowercase letters, digits, and _. It names the action in the API and in URLs.'} value={fixedId ?? str(raw.id)} onChange={(v) => set(['id'], v)} mono disabled={!!fixedId} error={issueAt(['id'])} />
        <Text label="Title" value={str(raw.title)} onChange={(v) => set(['title'], v)} error={issueAt(['title'])} />
        <Text label="Description" hint="What it does and when to use it, for a person and an agent." value={str(raw.description)} onChange={(v) => set(['description'], v)} multiline />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1 text-sm font-medium text-ink-100">Icon</div>
            <button type="button" aria-label={`Icon: ${str(raw.icon) || 'rocket'}. Change it`} onClick={(e) => setIconAnchor(e.currentTarget)} className="flex items-center gap-2 rounded-sm border border-ink-600 px-2 py-1 text-sm text-ink-200 hover:border-ink-300">
              <Icon name={str(raw.icon) || 'rocket'} className="size-5" /> Change
            </button>
            {iconAnchor && <IconPicker anchor={iconAnchor} value={str(raw.icon)} onPick={(n) => (set(['icon'], n), setIconAnchor(null))} onClose={() => setIconAnchor(null)} />}
          </div>
          <div className="min-w-48 flex-1">
            <Text label="Group" hint="The heading it is listed under when it has no home." value={str(raw.group)} onChange={(v) => set(['group'], v)} list={`${base}-groups`} />
            <datalist id={`${base}-groups`}>
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>
        <Home value={str(raw.home)} blueprints={blueprints} admin={admin} onChange={(v) => set(['home'], v)} error={issueAt(['home'])} />
      </Section>

      <Section title="Where it runs">
        <Blueprints label="Runs on" hint="An action on blueprints runs on one of their entities. One on none runs anywhere." empty="Nothing: it runs anywhere" value={raw.blueprint} onChange={(v) => set(['blueprint'], v)} blueprints={blueprints} error={issueAt(['blueprint'])} />
        {raw.where !== undefined && <YamlOnly what="A where filter narrows which entities it runs on" />}
        {(raw.self === true || (!!people && listOf(raw.blueprint).includes(people))) && <Check label="Only on the person's own" hint="It runs only on the caller's own person, the one the estate finds for whoever signs in, and shows on nobody else's page, an admin's view included. Who may run it is still its access." checked={raw.self === true} onChange={(v) => set(['self'], v || undefined)} error={issueAt(['self'])} />}
      </Section>

      <Section title="Before it runs">
        <Check label="Someone else approves each run" hint="The run waits until a person who holds the approve permission, and did not ask, approves it." checked={raw.approval === true} onChange={(v) => set(['approval'], v)} />
        {raw.approval === true && <Check label="The person who asked may approve it too" hint="For an estate with one approver. The run still shows who asked and who approved. Turn it off once a second person approves." checked={raw.selfApproval === true} onChange={(v) => set(['selfApproval'], v)} error={issueAt(['selfApproval'])} />}
        <Check label="Ask for a check first" hint="The form shows the person everything they filled in before it is sent. For an action that is hard to undo." checked={raw.confirm === true} onChange={(v) => set(['confirm'], v)} />
        <Check label="Run only from its rows" hint="No tile on the Self-service page: people run it from a row, an entity's page, or a tick of several, such as approving a record in an inbox." checked={raw.listed === false} onChange={(v) => set(['listed'], v ? false : undefined)} error={issueAt(['listed'])} />
        <Check label="Only its tool starts it" hint="No form, no Run button, and nothing an agent is offered: a tool asks for runs on the machine port, such as a CLI that applies infrastructure. Its runs and approvals show as usual." checked={raw.form === false} onChange={(v) => set(['form'], v ? false : undefined)} />
        {raw.serial !== undefined && <YamlOnly what="Runs on the same entity with the same values of the serial inputs run one at a time" />}
        {raw.concurrency !== undefined && <YamlOnly what={`At most ${typeof raw.concurrency === 'number' ? raw.concurrency : 'a few'} of its runs are in flight at once; the rest wait their turn, oldest first`} />}
      </Section>

      <Section title={`Inputs · ${names.length}`}>
        {names.map((name, i) => {
          const def = inputs[name] ?? {}
          const at = (...rest: string[]) => ['inputs', name, ...rest]
          const type = (ACTION_INPUT_TYPES as readonly string[]).includes(str(def.type)) ? (str(def.type) as ActionInputType) : 'string'
          const kind = INPUT_KINDS[type]
          const takes = (option: InputOption) => kind.options.includes(option)
          // A rule is asked for where the kind takes it. One that counts picks is asked once the input takes a list, or while it still holds one.
          const rules = INPUT_RULES.filter((rule) => kind.rules.includes(rule) && (!kind.picks || def.many === true || def[rule] !== undefined))
          const ruled = INPUT_RULES.some((rule) => def[rule] !== undefined)
          const values = Array.isArray(def.values) ? (def.values as unknown[]).map(String).join('\n') : str(def.values)
          // The inputs above it: what its `when` may test and its worked-out value may read.
          const above = names.slice(0, i)
          const worked = def.value !== undefined
          const clauses = clausesOf(def.when)
          const unique = (def.unique && typeof def.unique === 'object' ? def.unique : {}) as Raw
          const uniqueOf = blueprints.find((b) => b.id === str(unique.blueprint))
          const shown = listOf(def.show)
          const picked = picksOf(kind, def).flatMap((id) => blueprints.find((b) => b.id === id) ?? [])
          const fieldName = (field: string) => picked.map((b) => b.fields[field]?.title).find(Boolean) ?? field
          return (
            <fieldset key={i} className="space-y-3 rounded-sm border border-ink-700 p-3">
              <legend className="px-1 font-mono text-[12px] text-ink-300">{name}</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-40 flex-1">
                  <Text label="Name" hint="Lowercase letters, digits, and _. Templates read it as inputs.name." value={name} onChange={(v) => rename(name, v)} mono error={issueAt(['inputs', name])} />
                </div>
                <div className="flex gap-1 pb-0.5">
                  <IconButton label={`Move ${name} up`} disabled={i === 0} onClick={() => move(name, -1)}>
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Move ${name} down`} disabled={i === names.length - 1} onClick={() => move(name, 1)}>
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Remove ${name}`} onClick={() => remove(name)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              </div>
              <Pick label="Type" hint={kind.description} value={type} onChange={(v) => retype(name, v as ActionInputType)} options={ACTION_INPUT_TYPES.map((t) => ({ value: t, label: INPUT_KINDS[t].title }))} error={issueAt(at('type'))} />
              <Text label="Title" value={str(def.title)} onChange={(v) => set(at('title'), v)} />
              <Text label="Description" hint="Shown under the title." value={str(def.description)} onChange={(v) => set(at('description'), v)} />
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {(!worked || def.required === true) && <Check label="Required" checked={def.required === true} onChange={(v) => set(at('required'), v)} error={issueAt(at('required'))} />}
                {takes('many') && (!worked || def.many === true) && <Check label="Takes a list" checked={def.many === true} onChange={(v) => set(at('many'), v)} error={issueAt(at('many'))} />}
              </div>
              {takes('values') && <Text label="Values" hint="One per line, or one template that gives a list, such as {{ entity.fields.versions }}." value={values} onChange={(v) => set(at('values'), enumValues(v))} multiline mono error={issueAt(at('values'))} />}
              {takes('display') && (
                <Pick
                  label="Shown as"
                  hint="Buttons suit a few values: every one is on the page, and one press picks it."
                  value={str(def.display) || 'list'}
                  onChange={(v) => set(at('display'), v === 'list' ? undefined : v)}
                  options={[
                    { value: 'list', label: 'A list to pick from' },
                    { value: 'buttons', label: 'Buttons' },
                  ]}
                  error={issueAt(at('display'))}
                />
              )}
              {kind.person && <p className="text-[13px] text-ink-300">{people ? `Picks from the people of the estate: ${blueprintName(people)}.` : 'Picks from the people of the estate.'}</p>}
              {(takes('blueprint') || takes('sort')) && (
                <div className="flex flex-wrap gap-3">
                  {takes('blueprint') && <Blueprints label="Picks from" empty="Pick a blueprint" value={def.blueprint} onChange={(v) => set(at('blueprint'), v)} blueprints={blueprints} error={issueAt(at('blueprint'))} />}
                  {takes('sort') && <Text label="Order" hint="A field, or -field for the other way. Title when empty." value={str(def.sort)} onChange={(v) => set(at('sort'), v)} mono error={issueAt(at('sort'))} />}
                </div>
              )}
              {takes('narrows') && targets.length > 0 && !def.many && (
                <Pick
                  label="Narrows what it runs on"
                  hint="Asked first; the pick of what it runs on then offers only those that hold it. Run on an entity, it is filled from it."
                  value={str(def.narrows)}
                  onChange={(v) => set(at('narrows'), v || undefined)}
                  options={[{ value: '', label: 'No: an input of its own' }, ...narrowOptions(kind, picksOf(kind, def)).map((n) => ({ value: n, label: n }))]}
                  error={issueAt(at('narrows'))}
                />
              )}
              {(kind.defaultAs === 'text' || kind.defaultAs === 'number') && (!worked || def.default !== undefined) && (
                <Text label="Default" hint="May hold {{ path }} over the entity, the inputs above, and who asks: {{ by.name }}, {{ by.address }}." value={def.default === undefined ? '' : String(def.default)} onChange={(v) => set(at('default'), kind.defaultAs === 'number' ? numberOr(v) : v)} mono error={issueAt(at('default'))} />
              )}
              {kind.defaultAs === 'toggle' && (!worked || def.default !== undefined) && <Check label="On by default" checked={def.default === true} onChange={(v) => set(at('default'), v)} error={issueAt(at('default'))} />}
              {((!kind.picks && !def.narrows) || worked) && (
                <Text
                  label="Work it out"
                  hint={
                    <>
                      An expression over the inputs above, such as lower(name) + '-' + env. The form shows what it gives and never asks for it; the hub works it out again at every run.{' '}
                      {above.length ? (
                        <>
                          It may read{' '}
                          {above.map((n, j) => (
                            <Fragment key={n}>
                              {j > 0 && ', '}
                              <code>{n}</code>
                            </Fragment>
                          ))}
                          .
                        </>
                      ) : (
                        'No input is above it to read.'
                      )}
                    </>
                  }
                  value={str(def.value)}
                  onChange={(v) => set(at('value'), v)}
                  mono
                  error={issueAt(at('value'))}
                />
              )}
              {rules.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
                  {rules.map((rule) => {
                    const ask = ruleAsk(kind, rule)
                    return <Text key={rule} label={ask.label} hint={ask.hint} value={def[rule] === undefined ? '' : String(def[rule])} onChange={(v) => set(at(rule), ask.number ? numberOr(v) : v)} mono error={issueAt(at(rule))} />
                  })}
                </div>
              )}
              {(takes('unique') || def.unique !== undefined) && (
                <div className="flex flex-wrap gap-3">
                  <Pick
                    label="Must be unique among"
                    hint="The hub refuses a value that an entity of this blueprint already holds, whatever its letters' case."
                    value={str(unique.blueprint)}
                    onChange={(v) => set(at('unique'), v ? { blueprint: v, field: blueprints.find((b) => b.id === v)?.fields[str(unique.field)] ? str(unique.field) : 'title' } : undefined)}
                    options={[{ value: '', label: 'No: it may hold what another does' }, ...blueprints.map((b) => ({ value: b.id, label: blueprintName(b.id) }))]}
                    error={issueAt(at('unique')) ?? issueAt(at('unique', 'blueprint'))}
                  />
                  {def.unique !== undefined && (
                    <Pick
                      label="Of all their"
                      value={str(unique.field)}
                      onChange={(v) => set(at('unique', 'field'), v)}
                      options={[{ value: 'key', label: 'Its key' }, { value: 'title', label: 'Its title' }, ...Object.entries(uniqueOf?.fields ?? {}).map(([n, f]) => ({ value: n, label: f.title ?? n }))]}
                      error={issueAt(at('unique', 'field'))}
                    />
                  )}
                </div>
              )}
              {(ruled || def.hint !== undefined || def.unique !== undefined) && <Text label="What to say when a rule is broken" hint="Said at the input in place of the rule's own words, such as: Give the ticket, as OPS-12." value={str(def.hint)} onChange={(v) => set(at('hint'), v)} error={issueAt(at('hint'))} />}
              {(takes('show') || def.show !== undefined) && (
                <Chips
                  label="Show under each option"
                  hint={`Up to ${SHOW_MAX} fields of what it picks, on a line under each option's title. A field the person may not see is left out.`}
                  empty="Its title alone"
                  more="Add a field"
                  picked={shown}
                  nameOf={fieldName}
                  options={shown.length < SHOW_MAX ? [...new Set(picked.flatMap((b) => Object.keys(b.fields)))].filter((n) => !shown.includes(n)).map((n) => ({ value: n, label: fieldName(n) })) : null}
                  onChange={(next) => set(at('show'), next)}
                  error={issueAt(at('show')) ?? shown.map((_, j) => issueAt(at('show', String(j)))).find(Boolean)}
                />
              )}
              {(def.when !== undefined || (i > 0 && !def.narrows)) && (
                <AskWhen
                  clauses={clauses}
                  error={issueAt(at('when'))}
                  fields={above}
                  choices={(field) => valuesOf(inputs[field])}
                  onChange={(next) => set(at('when'), filterOf(next))}
                />
              )}
              {takes('current') && !kind.picks && def.many === true && (
                <Text label="What it holds now" hint="A template of the list the entity holds now, such as {{ entity.fields.allowed_origins }}. The form starts from it and shows what the run adds and removes; the hub keeps it on the run and refuses a run that changes nothing." value={str(def.current)} onChange={(v) => set(at('current'), v)} mono error={issueAt(at('current'))} />
              )}
              {(def.where !== undefined || (def.current !== undefined && !!kind.picks)) && <YamlOnly what="A where filter or a current template on this input" />}
            </fieldset>
          )
        })}
        <Button onClick={add}>
          <span className="flex items-center gap-1.5">
            <Plus className="size-3" /> Add an input
          </span>
        </Button>
      </Section>

      <Section title={`Sections · ${sections.length}`}>
        <p className="text-[13px] text-ink-400">A section is a heading over some of the inputs. The form asks its sections in this order, and each one's inputs in the order it names them.</p>
        {sections.map((section, s) => {
          const title = sectionName(section, s)
          return (
            <fieldset key={s} className="space-y-3 rounded-sm border border-ink-700 p-3">
              <legend className="px-1 text-[12px] text-ink-300">{`Section ${s + 1}`}</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-40 flex-1">
                  <Text label="Heading" value={str(section.title)} onChange={(v) => set(['sections', s, 'title'], v)} error={issueAt(['sections', s, 'title'])} />
                </div>
                <div className="flex gap-1 pb-0.5">
                  <IconButton label={`Move the section ${title} up`} disabled={s === 0} onClick={() => setSections(sectionShifted(sections, s, -1))}>
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Move the section ${title} down`} disabled={s === sections.length - 1} onClick={() => setSections(sectionShifted(sections, s, 1))}>
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton label={`Remove the section ${title}`} onClick={() => set(['sections'], sections.filter((_, j) => j !== s))}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              </div>
              <Text label="Description" hint="Shown under the heading." value={str(section.description)} onChange={(v) => set(['sections', s, 'description'], v)} error={issueAt(['sections', s, 'description'])} />
              <Problem error={issueAt(['sections', s, 'inputs']) ?? issueAt(['sections', s])} />
              <SectionInputs
                label={`The inputs of ${title}`}
                names={section.inputs}
                sections={sections.map(sectionName)}
                at={s}
                errorAt={(i) => issueAt(['sections', s, 'inputs', i])}
                onShift={(name, by) => setSections(shifted(sections, s, name, by))}
                onPlace={(name, to) => setSections(placed(sections, name, to))}
              />
            </fieldset>
          )
        })}
        {sections.length > 0 && loose.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] text-ink-300">In no section, so asked last, under no heading:</p>
            <SectionInputs label="The inputs in no section" names={loose} sections={sections.map(sectionName)} at={null} errorAt={() => undefined} onPlace={(name, to) => setSections(placed(sections, name, to))} />
          </div>
        )}
        <Button onClick={() => set(['sections'], [...sections, { title: `Section ${sections.length + 1}`, inputs: loose }])}>
          <span className="flex items-center gap-1.5">
            <Plus className="size-3" /> Add a section
          </span>
        </Button>
        <Check
          label="Walk through it as steps"
          hint={sections.length ? 'The form shows one section at a time, with Back and Next, and checks each before the next. The last step runs it.' : 'A form is walked a section at a time. Add a section first.'}
          checked={raw.walk === true}
          disabled={!sections.length && raw.walk !== true}
          onChange={(v) => set(['walk'], v)}
          error={issueAt(['walk'])}
        />
      </Section>

      <Section title="What does the work">
        <Pick label="Backend" value={str(backend.type)} onChange={(v) => set(['backend'], BACKENDS.find((b) => b.type === v)!.skeleton)} options={BACKENDS.map((b) => ({ value: b.type, label: b.label }))} hint="Changing it starts the backend afresh." />
        {backend.type === 'webhook' && (
          <>
            <Text label="URL" value={str(backend.url)} onChange={(v) => set(['backend', 'url'], v)} mono error={issueAt(['backend', 'url'])} />
            <div className="flex flex-wrap gap-3">
              <Pick label="Method" value={str(backend.method) || 'POST'} onChange={(v) => set(['backend', 'method'], v === 'POST' ? undefined : v)} options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'DELETE', label: 'DELETE' }]} />
              <Text label="Secret" hint="A hub secret, sent as a bearer token." value={str(backend.secretRef)} onChange={(v) => set(['backend', 'secretRef'], v || undefined)} mono error={issueAt(['backend', 'secretRef'])} />
              <Text label="As the person" hint="A delegate this hub is set up with. The call then carries the token of whoever asked, not a secret." value={str(backend.onBehalf)} onChange={(v) => set(['backend', 'onBehalf'], v || undefined)} mono />
            </div>
            <Pick label="The run ends" value={str(backend.finish) || 'report'} onChange={(v) => set(['backend', 'finish'], v === 'answer' || v === 'reveal' ? v : undefined)} options={[{ value: 'report', label: 'When the backend reports' }, { value: 'answer', label: 'On the answer' }, { value: 'reveal', label: 'On the answer, shown once' }]} hint="On the answer: a 2xx succeeds the run, for an API that reports nothing after. Shown once: the answer is a secret, given to whoever asked and never kept." />
            <div className="flex flex-wrap gap-3">
              <Text label="Wait for the answer" hint="Such as 15m. 15m when empty. A run with no answer by then ends with its outcome unknown." value={str(backend.timeout)} onChange={(v) => set(['backend', 'timeout'], v || undefined)} mono error={issueAt(['backend', 'timeout'])} />
            </div>
            {(backend.headers !== undefined || backend.body !== undefined) && <YamlOnly what="Headers and a body" />}
          </>
        )}
        {backend.type === 'github_workflow' && (
          <>
            <div className="flex flex-wrap gap-3">
              <Text label="Owner" value={str(backend.owner)} onChange={(v) => set(['backend', 'owner'], v)} mono error={issueAt(['backend', 'owner'])} />
              <Text label="Repository" value={str(backend.repo)} onChange={(v) => set(['backend', 'repo'], v)} mono error={issueAt(['backend', 'repo'])} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Text label="Workflow" hint="Its file name, such as deploy.yaml." value={str(backend.workflow)} onChange={(v) => set(['backend', 'workflow'], v)} mono error={issueAt(['backend', 'workflow'])} />
              <Text label="Branch" hint="main when empty." value={str(backend.ref)} onChange={(v) => set(['backend', 'ref'], v)} mono />
            </div>
            <Text label="Secret" hint="A hub secret holding a token that may run the workflow." value={str(backend.secretRef)} onChange={(v) => set(['backend', 'secretRef'], v)} mono error={issueAt(['backend', 'secretRef'])} />
            <Text label="Workflow inputs" hint="One name=value per line. A value may hold {{ path }}." value={pairsText(backend.inputs)} onChange={(v) => set(['backend', 'inputs'], pairs(v))} multiline mono />
          </>
        )}
        {backend.type === 'record' && (
          <>
            <div className="flex flex-wrap gap-3">
              <Text label="Source" hint="The source it writes as, registered for the blueprint." value={str(backend.source)} onChange={(v) => set(['backend', 'source'], v)} mono error={issueAt(['backend', 'source'])} />
              <Text label="Blueprint" value={str(backend.blueprint)} onChange={(v) => set(['backend', 'blueprint'], v)} mono error={issueAt(['backend', 'blueprint'])} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Text label="Key" hint="May hold {{ path }}, such as {{ run.id }}." value={str(backend.key)} onChange={(v) => set(['backend', 'key'], v)} mono error={issueAt(['backend', 'key'])} />
              <Pick label="Writes" value={str(backend.mode) || 'upsert'} onChange={(v) => set(['backend', 'mode'], v === 'upsert' ? undefined : v)} options={[{ value: 'upsert', label: 'A new or existing entity' }, { value: 'enrich', label: 'Only an existing entity' }]} />
            </div>
            {(backend.fields !== undefined || backend.relations !== undefined || backend.title !== undefined) && <YamlOnly what="Its title, fields, and relations" />}
          </>
        )}
        {backend.type === 'runner' && (
          <>
            <Text label="Runner" hint="The runner source that claims the job." value={str(backend.runner)} onChange={(v) => set(['backend', 'runner'], v)} mono error={issueAt(['backend', 'runner'])} />
            <Text label="Command" hint="One argument per line. Each may hold {{ path }}." value={Array.isArray(backend.command) ? (backend.command as unknown[]).map(String).join('\n') : ''} onChange={(v) => set(['backend', 'command'], v.split('\n').filter((l) => l.trim()))} multiline mono error={issueAt(['backend', 'command'])} />
            <div className="flex flex-wrap gap-3">
              <Text label="Time limit" hint="Such as 10m. 10m when empty." value={str(backend.timeout)} onChange={(v) => set(['backend', 'timeout'], v)} mono error={issueAt(['backend', 'timeout'])} />
            </div>
            <Text label="Environment" hint="One NAME=value per line." value={pairsText(backend.env)} onChange={(v) => set(['backend', 'env'], pairs(v))} multiline mono />
          </>
        )}
        {backend.type === 'job' && (
          <>
            <p className="text-[12px] text-ink-300">For work that runs long or waits for approval: the run's job starts the moment it is approved, and whoever asked need not stay.</p>
            <div className="flex flex-wrap gap-3">
              <Text label="Starter" hint="The runner source of the starter that starts the job." value={str(backend.starter)} onChange={(v) => set(['backend', 'starter'], v)} mono error={issueAt(['backend', 'starter'])} />
              <Text label="Template" hint="One of the starter's own job templates, by name. It says what the job runs as, so it may read only a locked field of the entity the run is on, as infra-apply-{{ entity.fields.infra_principal }}." value={str(backend.template)} onChange={(v) => set(['backend', 'template'], v)} mono error={issueAt(['backend', 'template'])} />
            </div>
            <Text label="Image" hint="The starter refuses one its template does not allow. May hold {{ path }}." value={str(backend.image)} onChange={(v) => set(['backend', 'image'], v)} mono error={issueAt(['backend', 'image'])} />
            <Text label="Command" hint="One argument per line; empty runs the image's own. Each may hold {{ path }}." value={Array.isArray(backend.command) ? (backend.command as unknown[]).map(String).join('\n') : ''} onChange={(v) => set(['backend', 'command'], v.split('\n').filter((l) => l.trim()))} multiline mono error={issueAt(['backend', 'command'])} />
            <Text label="Arguments" hint="One per line. Each may hold {{ path }}." value={Array.isArray(backend.args) ? (backend.args as unknown[]).map(String).join('\n') : ''} onChange={(v) => set(['backend', 'args'], v.split('\n').filter((l) => l.trim()))} multiline mono error={issueAt(['backend', 'args'])} />
            <Text label="Environment" hint="One NAME=value per line." value={pairsText(backend.env)} onChange={(v) => set(['backend', 'env'], pairs(v))} multiline mono />
            <Text label="Ceiling" hint="The longest a run may take, such as 12h. 7d when empty." value={str(raw.ceiling)} onChange={(v) => set(['ceiling'], v)} mono error={issueAt(['ceiling'])} />
          </>
        )}
      </Section>

      {admin && (
        <Section title="Who may run it">
          <Check label="Everyone signed in" hint="Without this or a grant, only an admin runs it." checked={access.everyone === true} onChange={(v) => set(['access', 'everyone'], v)} />
          <Check
            label="Open to its home's people"
            hint={str(raw.home) ? 'Whoever owns its home runs it, as well as anyone named here.' : 'It has no home yet. Pick one under About it first.'}
            checked={!!access.home}
            disabled={!str(raw.home) && !access.home}
            onChange={(v) => set(['access', 'home'], v)}
            error={issueAt(['access', 'home'])}
          />
          {!!access.home && ways.length > 0 && (
            <fieldset className="ml-6 space-y-1.5">
              <legend className="mb-1 text-[12px] text-ink-400">Only those who own it as one of these. With none picked, any way of owning it counts.</legend>
              {ways.map((w) => (
                <Check key={w} label={w} checked={homeWays.includes(w)} onChange={(v) => setWay(w, v)} />
              ))}
            </fieldset>
          )}
          {Array.isArray(access.audiences) && access.audiences.length > 0 && <YamlOnly what={`${access.audiences.length === 1 ? 'an audience names' : `${access.audiences.length} audiences name`} more people`} />}
          {Array.isArray(access.grants) && access.grants.length > 0 && <YamlOnly what={`${access.grants.length} ${access.grants.length === 1 ? 'grant names' : 'grants name'} more people`} />}
          {Array.isArray(access.rules) && access.rules.length > 0 && <YamlOnly what={`${access.rules.length === 1 ? 'a rule decides' : `${access.rules.length} rules decide`} who runs it on which entity`} />}
        </Section>
      )}
    </div>
  )
}

/** Values typed one per line, or a single template that gives the list. */
function enumValues(text: string): string[] | string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length === 1 && lines[0]!.includes('{{') ? lines[0]! : lines
}

function pairsText(value: unknown): string {
  return value && typeof value === 'object' ? Object.entries(value as Raw).map(([k, v]) => `${k}=${String(v)}`).join('\n') : ''
}

function pairs(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2">
        <Kicker>{title}</Kicker>
      </legend>
      {children}
    </fieldset>
  )
}

const HOME_LOCKED = 'Only an admin sets the home of an action'

/**
 * The home of an action: one entity, of any blueprint, that it belongs to. An
 * admin picks the blueprint and then finds the entity. Anyone else reads it,
 * and is told why they cannot change it.
 */
function Home({ value, blueprints, admin, onChange, error }: { value: string; blueprints: Blueprint[]; admin: boolean; onChange: (v: string | undefined) => void; error?: string }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}>
      <div id={`${id}-label`} className="mb-1 text-sm font-medium text-ink-100">
        Home
      </div>
      <p id={`${id}-hint`} className="mb-1 text-[12px] text-ink-400">
        The entity it belongs to, of any blueprint. It is listed under its home, and on its home's page.{!admin && ` ${HOME_LOCKED}.`}
      </p>
      {error && (
        <p className="mb-1 text-[12px] font-medium text-red">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-200" title={admin ? undefined : HOME_LOCKED}>
          {value ? <HomeRef value={value} /> : 'None'}
        </span>
        {admin && <HomePicker value={value || null} blueprints={blueprints} onChange={(v) => onChange(v ?? undefined)} />}
      </div>
    </div>
  )
}

/** What was typed as a number when it is one, and as typed when it is not, so the check says what is wrong with it. */
function numberOr(typed: string): number | string {
  return typed.trim() !== '' && Number.isFinite(Number(typed)) ? Number(typed) : typed
}

const DAYS = 'A day as YYYY-MM-DD, or today, today+30d, today-1y.'
/** How each rule is asked for, in the words of what the kind's rule measures: a number, a day, a moment, characters, or picks. */
function ruleAsk(kind: InputKind, rule: InputRule): { label: string; hint?: string; number?: true } {
  const floor = rule === 'min' || rule === 'minLength'
  if (rule === 'pattern') return { label: 'Pattern', hint: 'A regular expression the whole value fits, such as [A-Z]+-[0-9]+.' }
  if (rule === 'minLength' || rule === 'maxLength') return { label: `${floor ? 'Fewest' : 'Most'} ${kind.picks ? 'picked' : 'characters'}`, number: true }
  if (kind.bounds === 'number') return { label: floor ? 'Least' : 'Most', number: true }
  return { label: floor ? 'Earliest' : 'Latest', hint: kind.bounds === 'instant' ? `A moment with an offset, as 2026-03-10T14:30:00Z. ${DAYS}` : DAYS }
}

function YamlOnly({ what }: { what: string }) {
  return <p className="text-[13px] text-ink-400">{what}: change it in the YAML tab.</p>
}

function Text({ label, hint, value, onChange, error, mono = false, multiline = false, disabled = false, list }: { label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; error?: string; mono?: boolean; multiline?: boolean; disabled?: boolean; list?: string }) {
  const id = useId()
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const cls = `${input} w-full ${mono ? 'font-mono text-[12px]' : ''} disabled:opacity-60`
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-100">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-1 text-[12px] text-ink-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mb-1 text-[12px] font-medium text-red">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
      {multiline ? (
        <textarea id={id} aria-describedby={describedBy} aria-invalid={!!error || undefined} className={`${cls} min-h-20`} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={!mono} />
      ) : (
        <input id={id} type="text" list={list} aria-describedby={describedBy} aria-invalid={!!error || undefined} className={cls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={!mono} />
      )}
    </div>
  )
}

/** One blueprint or several: those picked, each with a button to take it off, and a pick to add another. Written as a name for one and a list for more. */
function Blueprints({ label, hint, empty, value, onChange, blueprints, error }: { label: string; hint?: string; empty: string; value: unknown; onChange: (v: string | string[] | undefined) => void; blueprints: Blueprint[]; error?: string }) {
  const blueprintName = useBlueprintName()
  const picked = Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []
  return (
    <Chips
      label={label}
      hint={hint}
      empty={empty}
      more="Add a blueprint"
      picked={picked}
      nameOf={blueprintName}
      options={blueprints.filter((b) => !picked.includes(b.id)).map((b) => ({ value: b.id, label: blueprintName(b) }))}
      onChange={(next) => onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next)}
      error={error}
    />
  )
}

/** Some of many: those picked, in order, each with a button to take it off, and a pick to add another while `options` offers any. */
function Chips({ label, hint, empty, more, picked, nameOf, options, onChange, error }: { label: string; hint?: string; empty: string; more: string; picked: string[]; nameOf: (id: string) => string; options: { value: string; label: string }[] | null; onChange: (next: string[]) => void; error?: string }) {
  return (
    <div className="space-y-2">
      {picked.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {picked.map((id, i) => (
            <li key={i} className="flex items-center gap-1 rounded-sm border border-ink-600 py-0.5 pr-0.5 pl-2 text-sm text-ink-200">
              {nameOf(id)}
              <IconButton label={`Take ${nameOf(id)} off`} onClick={() => onChange(picked.filter((_, j) => j !== i))}>
                <Trash2 className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {options ? <Pick label={picked.length ? `${label}: add another` : label} hint={hint} value="" onChange={(v) => v && onChange([...picked, v])} options={[{ value: '', label: picked.length ? more : empty }, ...options]} error={error} /> : <Problem error={error} />}
    </div>
  )
}

/** What is wrong with a part of the form that has no one control to say it at. */
function Problem({ error }: { error?: string }) {
  if (!error) return null
  return (
    <p className="text-[12px] font-medium text-red">
      <span className="sr-only">Error: </span>
      {error}
    </p>
  )
}

/** The values an input offers, where it offers a few: what a condition on it picks its value from. Null where the value is typed. */
function valuesOf(def: Raw | undefined): string[] | null {
  const type = def && (ACTION_INPUT_TYPES as readonly unknown[]).includes(def.type) ? (def.type as ActionInputType) : null
  if (!type) return null
  if (INPUT_KINDS[type].defaultAs === 'toggle') return ['true', 'false']
  return INPUT_KINDS[type].picks === 'values' && Array.isArray(def!.values) ? def!.values.map(String) : null
}

/** When an input is asked: conditions over the inputs above it, every one of which must hold. A `when` the conditions cannot hold stays in the YAML. */
function AskWhen({ clauses, fields, choices, onChange, error }: { clauses: GridClause[] | null; fields: string[]; choices: (field: string) => string[] | null; onChange: (next: GridClause[]) => void; error?: string }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}>
      <div id={`${id}-label`} className="mb-1 text-sm font-medium text-ink-100">
        Ask only when
      </div>
      <p id={`${id}-hint`} className="mb-1 text-[12px] text-ink-400">
        Each condition tests an input above this one, and every one must hold. An input that is not asked is not required, and is sent as nothing.
      </p>
      <Problem error={error} />
      {clauses === null ? (
        <YamlOnly what="A when with or, not, or a list of values" />
      ) : (
        <div className="space-y-2">
          {clauses.length === 0 && <p className="text-[13px] text-ink-300">Always asked.</p>}
          <Conditions clauses={clauses} onChange={onChange} fields={fields.map((n) => ({ id: n, title: n }))} ops={() => WHEN_OPS} choices={(field) => choices(field)?.map((value) => ({ value, label: value })) ?? null} add="Add a condition" />
        </div>
      )}
    </div>
  )
}

/** The inputs of one section, or of none: each with where it is, a pick to put it elsewhere, and, inside a section, buttons to move it. */
function SectionInputs({ label, names, sections, at, errorAt, onShift, onPlace }: { label: string; names: string[]; sections: string[]; at: number | null; errorAt: (i: number) => string | undefined; onShift?: (name: string, by: -1 | 1) => void; onPlace: (name: string, to: number | null) => void }) {
  if (!names.length) return null
  return (
    <ul aria-label={label} className="space-y-1.5">
      {names.map((name, i) => (
        <li key={i}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-24 flex-1 font-mono text-[12px] text-ink-200">{name}</span>
            {onShift && (
              <>
                <IconButton label={`Move ${name} up in its section`} disabled={i === 0} onClick={() => onShift(name, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label={`Move ${name} down in its section`} disabled={i === names.length - 1} onClick={() => onShift(name, 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
              </>
            )}
            <select aria-label={`Section of ${name}`} className={input} value={at === null ? '' : String(at)} onChange={(e) => onPlace(name, e.target.value === '' ? null : Number(e.target.value))}>
              {sections.map((title, s) => (
                <option key={s} value={String(s)}>
                  {title}
                </option>
              ))}
              <option value="">None: asked last</option>
            </select>
          </div>
          <Problem error={errorAt(i)} />
        </li>
      ))}
    </ul>
  )
}

function Pick({ label, hint, value, onChange, options, error }: { label: string; hint?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; error?: string }) {
  const id = useId()
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-100">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-1 text-[12px] text-ink-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mb-1 text-[12px] font-medium text-red">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
      <select id={id} aria-describedby={describedBy} aria-invalid={!!error || undefined} className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        {!options.some((o) => o.value === value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function Check({ label, hint, checked, onChange, error, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; error?: string; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined} aria-invalid={!!error || undefined} />
      <div>
        <label htmlFor={id} className="text-sm text-ink-100">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-[12px] text-ink-400">
            {hint}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className="text-[12px] font-medium text-red">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, disabled = false, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="flex size-7 items-center justify-center rounded-sm border border-ink-600 text-ink-300 hover:border-ink-300 hover:text-ink-100 disabled:opacity-30">
      {children}
    </button>
  )
}

/** What an action can hold, for whoever writes the YAML. Its kinds of input are read from the registry, so it names every one. */
export function Reference() {
  return (
    <details className="rounded-sm border border-ink-700 px-3 py-2 text-[13px] text-ink-300">
      <summary className="cursor-pointer text-ink-200">What an action can hold</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <b className="text-ink-100">Inputs</b>, each of a <code>type</code>:
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {ACTION_INPUT_TYPES.map((type) => {
              const kind = INPUT_KINDS[type]
              const takes = [...kind.options, ...kind.rules]
              return (
                <li key={type}>
                  <code>{type}</code>: {kind.description}
                  {takes.length > 0 && ` Takes ${takes.join(', ')}.`}
                </li>
              )
            })}
          </ul>
          <code>many: true</code> takes a list. <code>min</code> and <code>max</code> hold a number, a day, or <code>today</code>, <code>today+30d</code>, <code>today-1y</code>; <code>minLength</code> and <code>maxLength</code> count characters, or the picks of a list. <code>hint</code> is what the person is told when a rule is broken. <code>display: buttons</code> draws a choice as buttons.
        </li>
        <li>
          <b className="text-ink-100">What the form asks by</b>: <code>when</code> on an input is a filter over the inputs above it, and the input is asked only while it holds; one not asked is sent as nothing. <code>value</code> is an expression over the inputs above it, such as <code>lower(name) + '-' + env</code>: the input is worked out, never asked. <code>unique: {'{ blueprint, field }'}</code> refuses a value an entity of that blueprint already holds in <code>key</code>, <code>title</code>, or a field. <code>show: [field, …]</code> puts up to {SHOW_MAX} fields under each option of an entity or a person.
        </li>
        <li>
          <b className="text-ink-100">Sections</b>: <code>sections</code> is a list of <code>title</code>, <code>description</code>, and the <code>inputs</code> under that heading; an input in none is asked last. <code>walk: true</code> shows one section at a time, as steps.
        </li>
        <li>
          <b className="text-ink-100">Backends</b>: webhook (url, secretRef or onBehalf, finish, timeout, body), github_workflow (owner, repo, workflow, inputs, secretRef), runner (runner, command, env, timeout), job (starter, template, image, command, args, env: one container for each run, started as the run is approved; the template is a fixed name, or reads a locked field of the entity), caller (nothing: the tool or person who asks carries it out and reports). <code>ceiling</code> is the longest a run may take, for a job, a webhook, a workflow, or a caller.
        </li>
        <li>
          <b className="text-ink-100">Templates</b>: any string may hold <code>{'{{ entity.fields.x }}'}</code>, <code>{'{{ inputs.y }}'}</code>, <code>{'{{ run.id }}'}</code>, <code>{'{{ by.name }}'}</code>, <code>{'{{ by.address }}'}</code>.
        </li>
        <li>
          <b className="text-ink-100">Before it runs</b>: <code>approval: true</code> waits for someone else to approve, and <code>selfApproval: true</code> lets the person who asked approve too; <code>confirm: true</code> shows the person what they filled in first; <code>form: false</code> leaves the action no form, so only its tool starts it; <code>serial: [input, …]</code> makes runs on the same entity with the same values of those inputs one line: a newer request replaces one not started yet, and only one runs at a time. <code>concurrency: n</code> lets at most <code>n</code> runs of the action be in flight at once, on any entity and across every batch: the rest wait their turn, oldest first, and nothing is replaced.
        </li>
        <li>
          <b className="text-ink-100">Tool</b>: <code>tool: {'{ tier: read }'}</code> makes it a command an agent calls and reads the answer of, with no form and no approval. Its tier is <code>read</code>, <code>data</code>, or <code>act</code>, its backend is a runner whose own rule serves that tier, and whoever holds the tier on the entity may call it. Only an admin, git, or a source its runner names defines one.
        </li>
        <li>
          <b className="text-ink-100">Access</b> names who may run it, with the same grants that decide who sees a blueprint. Only an admin sets it.
        </li>
        <li>
          <b className="text-ink-100">Home</b>: <code>home: blueprint:key</code> names the one entity it belongs to, of any blueprint. It is listed under its home and on its home's page, and <code>home: true</code> under access (or the ways of owning it, such as <code>[lead]</code>) opens it to the people who own that entity. Only an admin sets either.
        </li>
        <li>
          <b className="text-ink-100">Rules</b> under access say who runs it on which entity: <code>audiences</code> or <code>grants</code> for who they are, <code>owns</code> (<code>true</code>, or roles such as <code>[developer]</code>, or <code>[self]</code> for a person on their own person entity) for what they are to it, <code>where</code> for what it is, and <code>approval: true</code> to hold those runs for someone else, or <code>approval: self</code> for the person to approve their own once they have read it. <code>tiers: [read]</code> under access names the tool tiers whoever may run it holds on that entity. What a rule reads only an admin or a holder of access.values changes by hand.
        </li>
        <li>
          <b className="text-ink-100">Narrowing</b>: <code>narrows: env</code> on an input asks it before the entity it runs on, and offers only entities whose <code>env</code> it is.
        </li>
      </ul>
    </details>
  )
}
