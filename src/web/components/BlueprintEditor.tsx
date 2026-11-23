// A blueprint's editor, and the forms it is built from: its details, its
// properties and relations, its lifecycle, its ground, who sees it, and the
// blueprint as YAML. The model page opens it beside the graph; a phone opens
// it in a drawer. A relation is changed on its own in `RelationPopover`.

import { ArrowDown, ArrowUp, ChevronRight, FileCode, Lock, Plus, Table2, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { useChanged, useEscape } from '../layers.ts'
import { FIELD_TYPES, inheritCases, isLocked, type AccessRule, type Blueprint, type BlueprintOrigin, type FieldDef, type Filter, type GroundDef, type InheritCase, type MapDef, type RelationDef } from '../../shared/model.ts'
import type { ImportReport } from '../../shared/api.ts'
import { useActions, useBlueprintName, useBlueprints, useCan, useSources, useDeleteBlueprint, useImportModel, useIsAdmin, usePolicy, usePreview, useRenameBlueprint, useSaveBlueprint, useSetHubAccess, useTemplates } from '../api.ts'
import { classFor, hasRule, type FieldClass } from '../../shared/policy.ts'
import { AccessEditor } from './AccessEditor.tsx'
import { BlueprintIcon, Icon } from '../icons.tsx'
import { tidyGround } from '../ground.ts'
import { sourcesOf } from '../blueprint-sources.ts'
import { ago } from '../format.ts'
import { IconPicker } from './editors.tsx'
import { Popover } from './Popover.tsx'
import { FieldAccess, FieldForm, NAME, ParsedInput, specOf } from './FieldForm.tsx'
import { TypePill } from './FieldType.tsx'
import { Badge, Button, Empty, ErrorNote, input, Kicker, Link, Panel, TabPanel, Tabs } from './ui.tsx'

/** Why a blueprint's fields cannot be changed on its card, or null when they can. */
export function lockOf(b: Blueprint, canAuthor: boolean, adminOnly: boolean): string | null {
  if (b.origin.kind === 'git') return `lives in git: ${b.origin.file}`
  if (b.origin.kind === 'hub') return "the hub's own"
  if (adminOnly) return 'only an admin changes it'
  return canAuthor ? null : 'read only'
}

export const ORIGIN_LABEL: Record<BlueprintOrigin['kind'], string> = { ui: 'made by hand in Orrery', git: 'defined in git', source: 'brought by a source', hub: 'built into the hub' }

type Draft = { id: string; title: string; description: string; group: string; icon: string; wall: boolean; standalone: boolean; graceRuns: string; graceDuration: string; expireAfter: string; expireField: string; keepDeleted: string; statusField: string; statusRelations: string; fields: Record<string, FieldDef>; relations: Record<string, RelationDef>; ground?: GroundDef; map?: MapDef; access?: AccessRule; timeline?: AccessRule; adminEdit: boolean }

export function toDraft(bp: Blueprint | null): Draft {
  return {
    id: bp?.id ?? '',
    title: bp?.title ?? '',
    description: bp?.description ?? '',
    group: bp?.group ?? '',
    icon: bp?.icon ?? 'box',
    wall: bp?.wall ?? false,
    standalone: bp?.standalone ?? false,
    graceRuns: bp?.lifecycle?.grace?.runs?.toString() ?? '',
    graceDuration: bp?.lifecycle?.grace?.duration ?? '',
    expireAfter: bp?.lifecycle?.expire?.after ?? '',
    expireField: bp?.lifecycle?.expire?.field ?? '',
    keepDeleted: bp?.lifecycle?.keepDeleted ?? '',
    statusField: bp?.status?.field ?? '',
    statusRelations: bp?.status?.relations?.join(', ') ?? '',
    fields: structuredClone(bp?.fields ?? {}),
    relations: structuredClone(bp?.relations ?? {}),
    ground: bp?.ground ? structuredClone(bp.ground) : undefined,
    map: bp?.map ? structuredClone(bp.map) : undefined,
    access: bp?.access ? structuredClone(bp.access) : undefined,
    timeline: bp?.timeline ? structuredClone(bp.timeline) : undefined,
    adminEdit: !!bp?.adminEdit,
  }
}

export function toSpec(d: Draft): Record<string, unknown> {
  const spec: Record<string, unknown> = { id: d.id.trim(), title: d.title.trim(), description: d.description || undefined, group: d.group || undefined, icon: d.icon || undefined, wall: d.wall || undefined, standalone: d.standalone || undefined, fields: d.fields, relations: d.relations }
  const grace = d.graceRuns || d.graceDuration ? { runs: d.graceRuns ? Number(d.graceRuns) : undefined, duration: d.graceDuration || undefined } : undefined
  const expire = d.expireAfter ? { after: d.expireAfter, field: d.expireField || undefined } : undefined
  const keepDeleted = d.keepDeleted.trim() || undefined
  if (grace || expire || keepDeleted) spec.lifecycle = { grace, expire, keepDeleted }
  // Carried whoever saves: a reader outside the preview does not see the ground, and must not lose it.
  if (d.ground) spec.ground = d.ground
  // The form edits no map, so it carries the one the blueprint has: a save here must not drop it.
  if (d.map) spec.map = d.map
  if (d.access) spec.access = d.access
  if (d.timeline) spec.timeline = d.timeline
  if (d.adminEdit) spec.adminEdit = true
  if (d.statusField || d.statusRelations) spec.status = { field: d.statusField || undefined, relations: d.statusRelations ? d.statusRelations.split(',').map((s) => s.trim()).filter(Boolean) : undefined }
  return spec
}

type EditorTab = 'details' | 'properties' | 'relations' | 'lifecycle' | 'sources' | 'ground' | 'access' | 'yaml'

/** Where a blueprint came from, in a word, for its badge. */

export function BlueprintEditor({ bp, all, canAuthor, count, onDirty, onSaved, onClose }: { bp: Blueprint | null; all: Blueprint[]; canAuthor: boolean; count: number; onDirty: (dirty: boolean) => void; onSaved: (id: string) => void; onClose: () => void }) {
  const save = useSaveBlueprint()
  const remove = useDeleteBlueprint()
  const rename = useRenameBlueprint()
  const admin = useIsAdmin()
  const garden = usePreview('garden')
  const adminOnlyIds = useBlueprints().data?.adminOnly
  const adminOnly = !!bp && !admin && (adminOnlyIds ?? []).includes(bp.id)
  const locked = !canAuthor || (!!bp && isLocked(bp.origin)) || adminOnly
  const [draft, setDraft] = useState<Draft>(() => toDraft(bp))
  const [tab, setTab] = useState<EditorTab>('details')
  const [yaml, setYaml] = useState('')
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [addingField, setAddingField] = useState(false)
  const [addingRelation, setAddingRelation] = useState<string | null>(null)
  const edited = JSON.stringify(toSpec(draft)) !== JSON.stringify(toSpec(toDraft(bp)))
  const dirty = !bp || edited
  const yamlEdited = tab === 'yaml' && yaml !== toYaml(toSpec(draft))
  const changed = !locked && (edited || yamlEdited)
  useEscape(onClose, changed)
  useEffect(() => onDirty(changed), [changed, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  const submit = () => {
    const spec = tab === 'yaml' ? (parseYaml(yaml) as Record<string, unknown>) : toSpec(draft)
    const id = String(spec.id ?? draft.id)
    save.mutate({ id, spec }, { onSuccess: () => onSaved(id) })
  }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  // The YAML is the same blueprint as the form: going to it writes the form out, and leaving it reads what was typed back in.
  const pick = (next: EditorTab) => {
    if (next === tab) return
    if (next === 'yaml') setYaml(toYaml(toSpec(draft)))
    if (tab === 'yaml' && yamlEdited) {
      try {
        setDraft(toDraft({ ...(parseYaml(yaml) as Blueprint), origin: bp?.origin ?? { kind: 'ui' } }))
      } catch (e) {
        setYamlError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    setYamlError(null)
    setTab(next)
  }
  const fieldCount = Object.keys(draft.fields).length + 1
  const relationCount = Object.keys(draft.relations).length
  const tabs: { id: EditorTab; label: ReactNode }[] = [
    { id: 'details', label: 'Details' },
    { id: 'properties', label: <TabCount label="Properties" n={fieldCount} /> },
    { id: 'relations', label: <TabCount label="Relations" n={relationCount} /> },
    { id: 'lifecycle', label: 'Lifecycle' },
    ...(bp ? [{ id: 'sources' as const, label: 'Sources' }] : []),
    ...(garden ? [{ id: 'ground' as const, label: 'Ground' }] : []),
    ...(admin && bp ? [{ id: 'access' as const, label: 'Access' }] : []),
    {
      id: 'yaml',
      label: (
        <span className="inline-flex items-center gap-1" title="The blueprint as YAML">
          <FileCode className="size-3.5" aria-hidden />
          <span className="sr-only">YAML</span>
        </span>
      ),
    },
  ]
  const lockedWhy = !bp ? null : bp.origin.kind === 'git' ? `This blueprint lives in git, in ${bp.origin.file}. Change the file and the hub picks it up on the next pull.` : bp.origin.kind === 'hub' ? "This blueprint is the hub's own. The hub keeps its fields and entities itself." : adminOnly ? 'Only an admin changes this blueprint and its entities: who sees what is decided from it.' : !canAuthor ? 'You can read this blueprint. Changing it needs the architect role.' : null
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-ink-700 bg-ink-900 px-4 pt-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-800">
            <BlueprintIcon bp={{ icon: draft.icon }} className="size-6 text-ink-100" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg leading-tight font-semibold">{draft.title || 'Untitled blueprint'}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-400">
              {!bp && <Badge className="border-orbit/50 text-orbit">New blueprint</Badge>}
              {bp && <span>{count.toLocaleString()} {count === 1 ? 'entity' : 'entities'}</span>}
              {bp && (
                <Link to={{ page: 'model', id: bp.id }} className="inline-flex items-center gap-1 py-1 font-medium text-orbit hover:underline">
                  <Table2 className="size-3" aria-hidden /> Browse
                </Link>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {!locked && (
              <Button kind="solid" onClick={submit} disabled={save.isPending || (!dirty && !yamlEdited)}>
                Save
              </Button>
            )}
            <button type="button" className="btn btn-ghost px-2" onClick={onClose} title="Close" aria-label="Close the blueprint">
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="mt-3">
          <Tabs id="bp-editor" label="Blueprint" tabs={tabs} value={tab} onChange={pick} />
        </div>
      </div>
      <TabPanel id="bp-editor" value={tab} className="space-y-5 p-4">
        <ErrorNote error={save.error ?? remove.error ?? rename.error ?? yamlError} />
        {lockedWhy && (
          <div className="flex items-start gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-ink-300">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-400" aria-hidden />
            {lockedWhy}
          </div>
        )}
        {tab === 'yaml' ? (
          <div className="space-y-2">
            <textarea className={`${input} min-h-[60vh] w-full font-mono text-[12px]`} aria-label="The blueprint, in YAML" value={yaml} onChange={(e) => setYaml(e.target.value)} readOnly={locked} spellCheck={false} />
            <p className="text-[12px] text-ink-400">The same blueprint as the other tabs. What you type here shows there when you switch back.</p>
          </div>
        ) : tab === 'sources' && bp ? (
          <SourcesTab bp={bp} />
        ) : tab === 'access' && bp?.origin.kind === 'hub' ? (
          <HubAccess bp={bp} />
        ) : (
          <fieldset disabled={locked} className="min-w-0 space-y-6">
            {tab === 'details' && (
              <>
                <Section title="What it is">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Labelled label="Id" hint={bp ? undefined : 'Lower case, digits, and underscores. It cannot be typed again later, only renamed.'}>
                      <span className="flex gap-1">
                        <input className={`${input} w-full min-w-0 font-mono`} value={draft.id} onChange={(e) => set('id', e.target.value)} disabled={!!bp} placeholder="azure_sql_database" />
                        {bp && !locked && (
                          <button
                            type="button"
                            className="btn btn-ghost shrink-0 px-2 text-[12px]"
                            title="Give the blueprint a new id. Its entities, what people typed on them, relations, history, rules, and scorecards all move with it."
                            disabled={rename.isPending || dirty}
                            onClick={() => {
                              const to = prompt(`New id for ${bp.id}. Its ${count} entities and everything that names it move with it. A pusher that still writes ${bp.id} will bring it back.`, bp.id)?.trim()
                              if (to && to !== bp.id) rename.mutate({ id: bp.id, to }, { onSuccess: () => onSaved(to) })
                            }}
                          >
                            Rename
                          </button>
                        )}
                      </span>
                    </Labelled>
                    <Labelled label="Title">
                      <input className={`${input} w-full`} value={draft.title} onChange={(e) => set('title', e.target.value)} />
                    </Labelled>
                    <Labelled label="Description" className="md:col-span-2" hint="Written for people and for agents: what one of these is, and when to use it.">
                      <textarea className={`${input} w-full`} rows={3} value={draft.description} onChange={(e) => set('description', e.target.value)} />
                    </Labelled>
                    <div title="Shown for every entity of this blueprint that has no icon of its own">
                      <span className="label">Icon</span>
                      <IconField value={draft.icon} onChange={(name) => set('icon', name)} />
                    </div>
                    <Labelled label="Group">
                      <input className={`${input} w-full`} value={draft.group} onChange={(e) => set('group', e.target.value)} placeholder="Applications, Infrastructure…" />
                    </Labelled>
                  </div>
                </Section>
                <Section title="Where it shows">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.wall} onChange={(e) => set('wall', e.target.checked)} /> Show on the status wall
                  </label>
                  {!admin && bp?.restricted && <p className="text-[12px] text-ink-400">Not everyone sees this blueprint. An admin sets who does.</p>}
                </Section>
                <Section title="Findings">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.standalone} onChange={(e) => set('standalone', e.target.checked)} /> Its entities may stand alone
                  </label>
                  <p className="text-[12px] text-ink-400">An entity connected to nothing raises no finding, such as a mailing list nobody owns.</p>
                </Section>
                {!locked && bp && (
                  <Section title="Remove">
                    <div className="flex items-center gap-3 rounded-md border border-red-dim/60 px-3 py-2.5">
                      <p className="flex-1 text-[12px] text-ink-400">Its entities stay in the database but disappear from every view.</p>
                      <Button kind="danger" onClick={() => confirm(`Remove blueprint ${bp.id}? Its entities stay in the database but disappear from views.`) && remove.mutate(bp.id, { onSuccess: onClose })}>
                        <Trash2 className="size-3.5" /> Remove blueprint
                      </Button>
                    </div>
                  </Section>
                )}
              </>
            )}
            {tab === 'properties' && (
              <Section
                title="Properties"
                description="What each entity holds. Open one to change it."
                action={
                  !locked && (
                    <Button onClick={() => setAddingField(true)}>
                      <Plus className="size-3.5" /> Property
                    </Button>
                  )
                }
              >
                {addingField && <NewField existing={Object.keys(draft.fields)} onAdd={(name, def) => (set('fields', { ...draft.fields, [name]: def }), setAddingField(false))} onCancel={() => setAddingField(false)} />}
                <div className="divide-y divide-ink-800 overflow-hidden rounded-lg border border-ink-700">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className="w-3.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-ink-100">Title</span>
                      <span className="block font-mono text-[12px] text-ink-500">title · built in</span>
                    </span>
                    <TypePill def={{ type: 'string' }} />
                  </div>
                  {Object.entries(draft.fields).map(([name, f]) => (
                    <FieldRow key={name} blueprint={draft.id} name={name} def={f} locked={locked} onChange={(def) => set('fields', { ...draft.fields, [name]: def })} onRemove={() => set('fields', Object.fromEntries(Object.entries(draft.fields).filter(([k]) => k !== name)))} />
                  ))}
                </div>
              </Section>
            )}
            {tab === 'relations' && (
              <>
                <Section
                  title="Relations"
                  description="The blueprints an entity of this one points at. Drag from this card to another on the graph to add one there."
                  action={
                    !locked && (
                      <Button onClick={() => setAddingRelation(all[0]?.id ?? '')}>
                        <Plus className="size-3.5" /> Relation
                      </Button>
                    )
                  }
                >
                  {addingRelation !== null && <NewRelation all={all} target={addingRelation} existing={Object.keys(draft.relations)} onAdd={(name, def) => (set('relations', { ...draft.relations, [name]: def }), setAddingRelation(null))} onCancel={() => setAddingRelation(null)} />}
                  {relationCount > 0 ? (
                    <div className="divide-y divide-ink-800 overflow-hidden rounded-lg border border-ink-700">
                      {Object.entries(draft.relations).map(([name, r]) => (
                        <RelationRow key={name} name={name} def={r} all={all} locked={locked} onChange={(def) => set('relations', { ...draft.relations, [name]: def })} onRemove={() => set('relations', Object.fromEntries(Object.entries(draft.relations).filter(([k]) => k !== name)))} />
                      ))}
                    </div>
                  ) : (
                    addingRelation === null && <Empty>None yet.</Empty>
                  )}
                </Section>
                <Incoming bp={bp} all={all} />
              </>
            )}
            {tab === 'lifecycle' && (
              <>
                <Section title="When a source stops sending one" description="An entity a source no longer sends is kept until both have passed: this many runs without it, and this much time.">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Labelled label="Runs">
                      <input className={`${input} w-full font-mono`} value={draft.graceRuns} onChange={(e) => set('graceRuns', e.target.value)} placeholder="2" />
                    </Labelled>
                    <Labelled label="Time">
                      <input className={`${input} w-full font-mono`} value={draft.graceDuration} onChange={(e) => set('graceDuration', e.target.value)} placeholder="24h" />
                    </Labelled>
                  </div>
                </Section>
                <Section title="Expiry" description="Remove entities by age: for things that happened, like a deployment, rather than things that exist.">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Labelled label="Expire after">
                      <input className={`${input} w-full font-mono`} value={draft.expireAfter} onChange={(e) => set('expireAfter', e.target.value)} placeholder="never" />
                    </Labelled>
                    <Labelled label="Counted from">
                      <select className={`${input} w-full`} value={draft.expireField} onChange={(e) => set('expireField', e.target.value)}>
                        <option value="">When it was first seen</option>
                        {Object.entries(draft.fields)
                          .filter(([, f]) => f.type === 'datetime')
                          .map(([k, f]) => (
                            <option key={k} value={k}>
                              {f.title ?? k}
                            </option>
                          ))}
                      </select>
                    </Labelled>
                  </div>
                </Section>
                <Section title="After it is deleted" description="A deleted entity is kept this long, so one that comes back keeps its notes and edits. Shorten it for things that come and go, like pods.">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Labelled label="Keep deleted for">
                      <input className={`${input} w-full font-mono`} value={draft.keepDeleted} onChange={(e) => set('keepDeleted', e.target.value)} placeholder="the hub's default" />
                    </Labelled>
                  </div>
                </Section>
                <Section title="Status" description="An entity's status is the worst of its health checks, its alerts, how fresh it is, the field picked here, and the status of what these relations reach.">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Labelled label="From a field">
                      <select className={`${input} w-full`} value={draft.statusField} onChange={(e) => set('statusField', e.target.value)}>
                        <option value="">None</option>
                        {Object.entries(draft.fields)
                          .filter(([, f]) => f.type === 'enum')
                          .map(([k, f]) => (
                            <option key={k} value={k}>
                              {f.title ?? k}
                            </option>
                          ))}
                      </select>
                    </Labelled>
                    <Labelled label="Rolls up from">
                      <input className={`${input} w-full font-mono`} value={draft.statusRelations} onChange={(e) => set('statusRelations', e.target.value)} placeholder="<-system, nodes, team.department" />
                    </Labelled>
                  </div>
                </Section>
              </>
            )}
            {tab === 'ground' && garden && <GroundTab draft={draft} all={all} onChange={(ground) => set('ground', ground)} />}
            {tab === 'access' && admin && (
              <>
                <Section title="Who sees and changes it">
                  <AccessEditor value={draft.access} onChange={(rule) => set('access', rule)} what="this blueprint and its entities" ownerFields={Object.keys(draft.fields)} relations={Object.keys(draft.relations)} />
                  <label className="flex items-center gap-2 text-sm" title="Contributors and architects read it and change nothing. Blueprints that decide who sees what are admin only already">
                    <input type="checkbox" checked={draft.adminEdit} onChange={(e) => set('adminEdit', e.target.checked)} /> Only an admin changes this blueprint and its entities
                  </label>
                </Section>
                <Section title="Who reads its timeline">
                  <AccessEditor value={draft.timeline} onChange={(rule) => set('timeline', rule)} what="the timeline of each entity" open="Whoever sees an entity reads its timeline: what changed, who changed it, and what it replaced." />
                </Section>
              </>
            )}
          </fieldset>
        )}
      </TabPanel>
    </div>
  )
}

/** One of a blueprint's fields or relations, picked by name. A name that is no longer among them still shows, so it can be seen and changed. */
function Named({ label, hint, value, options, none = 'None', onChange }: { label: string; hint?: string; value: string | undefined; options: [id: string, title: string][]; none?: string; onChange: (value: string | undefined) => void }) {
  return (
    <Labelled label={label} hint={hint}>
      <select className={`${input} w-full`} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{none}</option>
        {value !== undefined && !options.some(([id]) => id === value) && <option value={value}>{value}</option>}
        {options.map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
      </select>
    </Labelled>
  )
}

/** Several of a blueprint's fields, each ticked or not. */
function Ticked({ label, value, options, onChange }: { label: string; value: string[]; options: [id: string, title: string][]; onChange: (value: string[]) => void }) {
  if (!options.length) return <p className="text-[12px] text-ink-400">{label}</p>
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map(([id, title]) => (
        <label key={id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.includes(id)} onChange={(e) => onChange(e.target.checked ? [...value, id] : value.filter((v) => v !== id))} /> {title}
        </label>
      ))}
    </div>
  )
}

/**
 * What the ground view reads of a blueprint. Each part names one of the
 * blueprint's own properties or relations; the ground shows what they hold
 * and adds nothing of its own. A budget is set on a number property itself.
 */
function GroundTab({ draft, all, onChange }: { draft: Draft; all: Blueprint[]; onChange: (ground: GroundDef | undefined) => void }) {
  const actions = useActions().data?.actions ?? []
  const ground = draft.ground ?? {}
  const set = (patch: Partial<GroundDef>) => onChange(tidyGround({ ...ground, ...patch }))
  const fields = (type?: FieldDef['type']): [string, string][] =>
    Object.entries(draft.fields)
      .filter(([, f]) => !type || f.type === type)
      .map(([k, f]) => [k, f.title ?? k])
  const numbers = fields('number')
  const trends = fields('trend')
  const template = ground.template
  const target = all.find((b) => b.id === draft.relations[template?.relation ?? '']?.target)
  const setTemplate = (patch: Partial<NonNullable<GroundDef['template']>>) => set({ template: { relation: '', ...template, ...patch } })
  // The numbers the ground reads: the named ones, and every one with a budget.
  const read = numbers.filter(([k]) => draft.fields[k]?.budget || k === ground.loop || k === ground.friction || k === ground.unwanted)
  return (
    <>
      <Section title="Numbers" description="The number properties the ground reads by name. Every number with a budget is read too, and drawn as a stake: set a budget on the property itself.">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Named label="Time for one round of work" hint="Such as the minutes from a push to its result." value={ground.loop} options={numbers} onChange={(loop) => set({ loop })} />
          <Named label="How often work gets stuck" hint="Drawn as clouds." value={ground.friction} options={numbers} onChange={(friction) => set({ friction })} />
          <Named label="What should not be there" hint="Such as suppressed warnings. Drawn as weeds." value={ground.unwanted} options={numbers} onChange={(unwanted) => set({ unwanted })} />
          <Named label="How much it is used" hint="Drawn as the height of the stem." value={ground.activity} options={numbers} onChange={(activity) => set({ activity })} />
        </div>
      </Section>
      <Section title="Built on" description="Properties that say what it is built on, such as a runtime and a base image, the deepest first. Drawn as soil.">
        <Labelled label="Properties" hint={`By id, with commas between: ${fields().map(([k]) => k).join(', ') || 'this blueprint has none yet'}`}>
          <ParsedInput className={`${input} w-full font-mono`} value={(ground.foundations ?? []).join(', ')} onChange={(text) => set({ foundations: text.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </Labelled>
      </Section>
      <Section title="Limits" description="Yes-or-no properties, each a limit that holds or does not, such as a protected branch. Drawn as fences.">
        <Ticked label="This blueprint has no yes-or-no property yet." value={ground.guards ?? []} options={fields('boolean')} onChange={(guards) => set({ guards })} />
      </Section>
      <Section title="Copied from" description="The relation to what its patterns were copied from. The ground shows everything else that copied from the same place.">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Named label="Relation" value={ground.taughtBy} options={Object.entries(draft.relations).map(([k, r]) => [k, r.title ?? k])} onChange={(taughtBy) => set({ taughtBy })} />
        </div>
      </Section>
      <Section title="Template and trial" description="What it was started from, and whether changes to the platform land on it first. A trial is drawn under glass.">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Named
            label="Template"
            hint="A relation to one entity."
            value={template?.relation}
            options={Object.entries(draft.relations)
              .filter(([, r]) => !r.many)
              .map(([k, r]) => [k, r.title ?? k])}
            onChange={(relation) => set({ template: relation ? { ...template, relation } : undefined })}
          />
          <Named label="On trial" value={ground.trial} options={fields('boolean')} onChange={(trial) => set({ trial })} />
          {template?.relation && (
            <>
              <Named label="Version it started at" hint="A property here." value={template.version} options={fields()} onChange={(version) => setTemplate({ version })} />
              <Named label="Version now" hint={target ? `A property of ${target.title}.` : 'A property of the template.'} value={template.current} options={Object.entries(target?.fields ?? {}).map(([k, f]) => [k, f.title ?? k])} onChange={(current) => setTemplate({ current })} />
              <Named label="Action that starts a new one" value={template.action} options={actions.map((a) => [a.id, a.title])} onChange={(action) => setTemplate({ action })} />
            </>
          )}
        </div>
      </Section>
      <Section title="Dates ahead" description="Date properties the forecast reads: what ends or falls due, such as a waiver.">
        <Ticked label="This blueprint has no date property yet." value={ground.ahead ?? []} options={fields('datetime')} onChange={(ahead) => set({ ahead })} />
      </Section>
      {read.length > 0 && trends.length > 0 && (
        <Section title="Pasts" description="The trend property that holds a number's past. The ground finds a trend that reads the number's history by itself; name one here only where it cannot.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {read.map(([k, title]) => (
              <Named
                key={k}
                label={title}
                none="Found by itself"
                value={ground.trends?.[k]}
                options={trends}
                onChange={(trend) => {
                  const { [k]: _was, ...rest } = ground.trends ?? {}
                  set({ trends: trend ? { ...rest, [k]: trend } : rest })
                }}
              />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** A tab's name with how many it holds. */
/** Who stands behind a blueprint: where it was defined, who adds to its definition, and who fills it. It only reads. */
function SourcesTab({ bp }: { bp: Blueprint }) {
  const sources = useSources()
  const held = useBlueprints().data?.held?.[bp.id]
  const canOpen = useCan('sources.manage')
  const { defined, shapedBy, filledBy } = sourcesOf(bp, sources.data?.sources ?? [], held)
  const name = (s: { id: string; title: string }) =>
    canOpen ? (
      <Link to={{ page: 'sources', id: s.id }} className="font-medium text-orbit hover:underline">
        {s.title}
      </Link>
    ) : (
      <span className="font-medium text-ink-100">{s.title}</span>
    )
  return (
    <div className="space-y-6">
      <ErrorNote error={sources.error} />
      <Section title="Where it was defined">
        <p className="text-sm text-ink-200">{defined}</p>
      </Section>
      <Section title="Who adds to it" description="Sources that offered this blueprint fields, relations, or choices it lacked.">
        {shapedBy.length ? (
          <ul className="divide-y divide-ink-800 rounded-md border border-ink-700">
            {shapedBy.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{name(s)}</span>
                <span className="shrink-0 text-[12px] text-ink-400" title={new Date(s.at).toLocaleString()}>
                  last {ago(s.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-400">No source adds to it.</p>
        )}
      </Section>
      <Section title="Who fills it" description="Sources that write its entities, with how many each owns now.">
        {filledBy.length ? (
          <ul className="divide-y divide-ink-800 rounded-md border border-ink-700">
            {filledBy.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {name(s)}
                  {s.byHand && <span className="ml-2 text-[12px] text-ink-400">people, by hand</span>}
                </span>
                <span className="shrink-0 text-[12px] text-ink-300 tabular-nums">{s.holds ? `owns ${s.holds.toLocaleString()}` : 'owns none'}</span>
                <span className="w-24 shrink-0 text-right text-[12px] text-ink-400" title={s.wroteAt ? new Date(s.wroteAt).toLocaleString() : undefined}>
                  {s.wroteAt ? ago(s.wroteAt) : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-400">Nothing writes its entities yet.</p>
        )}
      </Section>
    </div>
  )
}

function TabCount({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="rounded-full bg-ink-800 px-1.5 text-[12px] text-ink-400">{n}</span>
    </span>
  )
}

/** A titled part of the editor, with a line on what it is for and an action beside its title. */
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-ink-100">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] text-ink-400">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A form control with its label above it and a hint below. */
function Labelled({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-[12px] text-ink-500">{hint}</span>}
    </label>
  )
}

/**
 * Who sees one of the hub's own blueprints. Everything else about it is the
 * hub's; this is not, so it is set here, outside the locked form, and saved
 * on its own. No lines means admins only, which is where it starts. One whose
 * entities link to things, as a schedule links to what it runs on, may also
 * be opened to whoever sees what they link to: the hub names the relations.
 */
function HubAccess({ bp }: { bp: Blueprint }) {
  const set = useSetHubAccess()
  const relations = Object.keys(bp.relations)
  const saved = hasRule(bp.access) || bp.access?.subjects?.length ? bp.access : undefined
  const [rule, setRule] = useState<AccessRule | undefined>(() => (saved ? structuredClone(saved) : undefined))
  const dirty = JSON.stringify(rule ?? null) !== JSON.stringify(saved ?? null)
  return (
    <Panel>
      <div className="flex items-center border-b border-ink-800 px-3 py-2">
        <Kicker>Who sees it</Kicker>
        <span className="ml-auto" />
        <Button kind="solid" onClick={() => set.mutate({ id: bp.id, access: rule ?? null })} disabled={set.isPending || !dirty}>
          Save
        </Button>
      </div>
      <div className="space-y-3 p-3">
        <ErrorNote error={set.error} />
        <AccessEditor value={rule} onChange={setRule} what="this blueprint and its entities" adminsByDefault />
        {relations.length > 0 && <BySubjects rule={rule} relations={relations} onChange={setRule} />}
        <div className="text-[12px] text-ink-500">Only an admin changes it. The hub keeps its fields and entities itself.</div>
      </div>
    </Panel>
  )
}

/** Opens each entity of a hub blueprint to whoever sees what it links to, through every relation the hub gives it. */
function BySubjects({ rule, relations, onChange }: { rule: AccessRule | undefined; relations: string[]; onChange: (rule: AccessRule | undefined) => void }) {
  const on = !!rule?.subjects?.length
  const toggle = (checked: boolean) => {
    const { subjects: _was, ...rest } = rule ?? { grants: [] }
    const next: AccessRule = checked ? { ...rest, subjects: relations } : rest
    onChange(hasRule(next) || next.subjects?.length ? next : undefined)
  }
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-300">
      <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
      Also show each one to anyone who can see what it links to. They never change it.
    </label>
  )
}

/** Brings a model in: one the hub offers, or a file. Nothing that exists is changed, so importing again is harmless. */
export function ImportPanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  const templates = useTemplates(true)
  const bring = useImportModel()
  const [report, setReport] = useState<{ what: string; result: ImportReport } | null>(null)
  const run = (what: string, input: { template: string } | { yaml: string }) => bring.mutate(input, { onSuccess: (result) => setReport({ what, result }) })
  const line = (label: string, ids: string[]) =>
    ids.length > 0 && (
      <div>
        <span className="text-ink-400">{label}</span> <span className="font-mono text-[12px]">{ids.join(', ')}</span>
      </div>
    )
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Kicker>Import a model</Kicker>
          <p className="mt-1 text-sm text-ink-300">What does not exist is created and is yours to edit. A blueprint that exists gains the fields and relations it lacks. Nothing is changed or removed.</p>
        </div>
        <Button onClick={onClose}>Close</Button>
      </div>
      <ErrorNote error={bring.error ?? templates.error} />
      {(templates.data?.templates ?? []).map((t) => (
        <Panel key={t.id} className="space-y-2 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">{t.title}</div>
            <span className="ml-auto">
              <Button kind="solid" disabled={bring.isPending} onClick={() => run(t.title, { template: t.id })}>
                Import
              </Button>
            </span>
          </div>
          <p className="text-[12px] text-ink-300">{t.description}</p>
          <div className="font-mono text-[10px] text-ink-500">{t.blueprints.join(' · ')}</div>
        </Panel>
      ))}
      <Panel className="space-y-2 px-3 py-2">
        <div className="text-sm font-semibold">A file of your own</div>
        <p className="text-[12px] text-ink-300">A YAML file with any of blueprints, relationRules, scorecards, alertRules, and entities.</p>
        <input
          type="file"
          accept=".yaml,.yml"
          aria-label="A file of your own"
          className="text-[12px] text-ink-300"
          disabled={bring.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void file.text().then((yaml) => run(file.name, { yaml }))
            e.target.value = ''
          }}
        />
      </Panel>
      {report && (
        <Panel className="space-y-1 px-3 py-2 text-[12px]">
          <Kicker>{report.what}</Kicker>
          {line('Created', report.result.blueprints.created)}
          {line('Added to', report.result.blueprints.extended)}
          {line('Already there', report.result.blueprints.kept)}
          {line('Rules', report.result.rules.created)}
          {line('Scorecards', report.result.scorecards.created)}
          {line('Alert rules', report.result.alertRules.created)}
          {report.result.entities.created > 0 && (
            <div>
              <span className="text-ink-400">Entities</span> {report.result.entities.created}
            </div>
          )}
          {report.result.errors.map((error) => (
            <div key={error} className="text-red">
              {error}
            </div>
          ))}
          {report.result.blueprints.created.length + report.result.blueprints.extended.length + report.result.rules.created.length + report.result.scorecards.created.length + report.result.alertRules.created.length + report.result.entities.created === 0 && report.result.errors.length === 0 && <div className="text-ink-400">Everything in it was already here.</div>}
        </Panel>
      )}
    </div>
  )
}

function Incoming({ bp, all }: { bp: Blueprint | null; all: Blueprint[] }) {
  const blueprintName = useBlueprintName()
  if (!bp) return null
  const incoming = all.flatMap((b) => Object.entries(b.relations).filter(([, r]) => r.target === bp.id).map(([name, r]) => ({ from: b, name, r })))
  if (!incoming.length) return null
  return (
    <Section title="Pointed at by" description="Blueprints whose entities point at this one.">
      <div className="divide-y divide-ink-800 overflow-hidden rounded-lg border border-ink-700">
        {incoming.map((i) => (
          <div key={`${i.from.id}.${i.name}`} className="flex items-center gap-2 px-3 py-2">
            <BlueprintIcon bp={i.from} className="size-4 shrink-0 text-ink-300" />
            <span className="min-w-0 flex-1">
              <Link to={{ page: 'model', id: null, focus: i.from.id }} className="block truncate text-[13px] font-medium text-ink-100 hover:underline">
                {blueprintName(i.from)}
              </Link>
              <span className="block truncate font-mono text-[12px] text-ink-500">
                {i.name}
                {i.r.inverseTitle ? ` · seen here as ${i.r.inverseTitle}` : ''}
              </span>
            </span>
            {i.r.many && <Badge className="border-ink-600 text-ink-300">Many</Badge>}
          </div>
        ))}
      </div>
    </Section>
  )
}

function FieldRow({ blueprint, name, def, locked, onChange, onRemove }: { blueprint: string; name: string; def: FieldDef; locked: boolean; onChange: (def: FieldDef) => void; onRemove: () => void }) {
  const cls = useFieldClass(blueprint, name)
  const [open, setOpen] = useState(false)
  const admin = useIsAdmin()
  const agg = def.aggregation
  const derived = def.mirror ? `from ${def.mirror}` : agg ? `${agg.fn} of ${agg.relation}${agg.field ? ` ${agg.field}` : ''}${agg.window ? `, last ${agg.window.last}` : ''}${agg.per ? ` per ${agg.per}` : ''}` : def.pivoted ? `${def.pivoted.field} ▸ ${def.pivoted.key}` : def.calculation ? `= ${def.calculation}` : def.pivot ? 'pivoted' : null
  return (
    <div className={open ? 'bg-ink-850/60' : ''}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open} title={def.description}>
          <ChevronRight className={`size-3.5 shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-ink-100">{def.title ?? name}</span>
            {/* The name under the title, when they differ, and where a worked-out value comes from. */}
            {(def.title || derived) && <span className="block truncate font-mono text-[12px] text-ink-500">{[def.title && def.title !== name ? name : null, derived].filter(Boolean).join(' · ')}</span>}
          </span>
        </button>
        {def.overridable === false && <Badge className="border-ink-600 text-ink-400" title="Only sources write this field. Nobody sets or changes it in the web app"><Lock className="size-3" aria-hidden /> Locked</Badge>}
        {cls ? <Badge className="border-amber/50 text-amber" title={`In the ${cls.title} class: its audiences see this field, wherever it appears`}>{cls.title}</Badge> : (def.access || def.restricted) && <Badge className="border-amber/50 text-amber" title="Not everyone sees this field">Restricted</Badge>}
        {def.adminEdit && <Badge className="border-ink-600 text-ink-400" title="Only an admin changes this field">Admin edits</Badge>}
        <TypePill def={def} />
        {!locked && (
          <button type="button" className="rounded-md p-1 text-ink-500 hover:bg-red/10 hover:text-red" onClick={onRemove} title={`Remove ${name}`} aria-label={`Remove ${name}`}>
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-ink-800 px-3 py-3">
          <FieldForm def={def} onChange={onChange} />
          {admin && <FieldAccess blueprint={blueprint} name={name} def={def} onChange={onChange} />}
        </div>
      )}
    </div>
  )
}

/** The blueprint's icon as a form control: a click opens the icon set. */
function IconField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" className={`${input} mt-1 flex w-full items-center gap-2 text-left font-mono`} onClick={(e) => setAnchor(e.currentTarget)}>
        <Icon name={value} className="size-4 shrink-0 text-ink-200" />
        <span className="truncate">{value}</span>
      </button>
      {anchor && <IconPicker anchor={anchor} value={value} onPick={(name) => (onChange(name), setAnchor(null))} onClose={() => setAnchor(null)} />}
    </>
  )
}

function NewField({ existing, onAdd, onCancel }: { existing: string[]; onAdd: (name: string, def: FieldDef) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldDef['type']>('string')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  useEscape(onCancel, useChanged([name, type, title, description]))
  const ok = NAME.test(name) && !existing.includes(name) && name !== 'title'
  return (
    <form
      className="grid grid-cols-1 gap-2 md:grid-cols-2 rounded-lg border border-orbit/40 bg-orbit/5 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) onAdd(name, { type, title: title || undefined, description: description || undefined })
      }}
    >
      <input className={`${input} font-mono`} aria-label="Field name" placeholder="field_name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <select className={input} aria-label="Type" value={type} onChange={(e) => setType(e.target.value as FieldDef['type'])}>
        {FIELD_TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <input className={input} aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={input} aria-label="Description" placeholder="Description, for people and agents" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="md:col-span-2 flex gap-2">
        <Button type="submit" kind="solid" disabled={!ok}>
          Add
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function RelationRow({ name, def, all, locked, onChange, onRemove }: { name: string; def: RelationDef; all: Blueprint[]; locked: boolean; onChange: (def: RelationDef) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const blueprintName = useBlueprintName()
  const to = all.find((b) => b.id === def.target)
  return (
    <div className={open ? 'bg-ink-850/60' : ''}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open} title={def.description}>
          <ChevronRight className={`size-3.5 shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-ink-100">{def.title ?? name}</span>
            {def.title && def.title !== name && <span className="block truncate font-mono text-[12px] text-ink-500">{name}</span>}
          </span>
        </button>
        {def.required && <Badge className="border-amber/50 text-amber">Required</Badge>}
        {def.display === 'contain' && <Badge className="border-ink-600 text-ink-300" title="Lives inside its target">Nests</Badge>}
        {def.inherit && <Badge className="border-ink-600 text-ink-300" title={`Inherited from ${inheritCases(def).map(describeCase).join(', else ')} unless set`}>Inherits</Badge>}
        <span className="inline-flex max-w-40 items-center gap-1 rounded-full bg-orbit/10 px-2 py-px text-[12px] font-medium text-orbit">
          <BlueprintIcon bp={to} className="size-3 shrink-0" />
          <span className="truncate">{blueprintName(to ?? def.target)}</span>
          {def.many && <span className="shrink-0 opacity-80">· many</span>}
        </span>
        {!locked && (
          <button type="button" className="rounded-md p-1 text-ink-500 hover:bg-red/10 hover:text-red" onClick={onRemove} title={`Remove ${name}`} aria-label={`Remove ${name}`}>
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {open && <RelationForm def={def} all={all} onChange={onChange} className="border-t border-ink-800 px-3 py-3" />}
    </div>
  )
}

/** Everything a relation's definition says, as a form: the editor's rows and a card's popover both edit a relation with it. */
function RelationForm({ def, all, onChange, className = '' }: { def: RelationDef; all: Blueprint[]; onChange: (def: RelationDef) => void; className?: string }) {
  return (
    <div className={`grid grid-cols-1 gap-2 md:grid-cols-2 ${className}`}>
      <label className="block">
        <Kicker>Target</Kicker>
        <select className={`${input} mt-1 w-full font-mono`} value={def.target} onChange={(e) => onChange({ ...def, target: e.target.value })}>
          {all.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <Kicker>Display</Kicker>
        <select className={`${input} mt-1 w-full`} value={def.display ?? 'link'} onChange={(e) => onChange({ ...def, display: e.target.value as 'link' | 'contain', many: e.target.value === 'contain' ? false : def.many })}>
          <option value="link">line</option>
          <option value="contain">nest inside the target</option>
        </select>
      </label>
      <label className="block">
        <Kicker>Title</Kicker>
        <input className={`${input} mt-1 w-full`} value={def.title ?? ''} onChange={(e) => onChange({ ...def, title: e.target.value || undefined })} />
      </label>
      <label className="block">
        <Kicker>Inverse title</Kicker>
        <input className={`${input} mt-1 w-full`} value={def.inverseTitle ?? ''} onChange={(e) => onChange({ ...def, inverseTitle: e.target.value || undefined })} />
      </label>
      <label className="md:col-span-2 block">
        <Kicker>Description</Kicker>
        <input className={`${input} mt-1 w-full`} value={def.description ?? ''} onChange={(e) => onChange({ ...def, description: e.target.value || undefined })} />
      </label>
      <InheritEditor def={def} onChange={onChange} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!def.many} disabled={def.display === 'contain'} onChange={(e) => onChange({ ...def, many: e.target.checked })} /> many
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!def.required} onChange={(e) => onChange({ ...def, required: e.target.checked })} /> required
      </label>
    </div>
  )
}

/** One case of an inherited relation in words: `when type = backend: program.backend_team`. */
function describeCase(c: InheritCase): string {
  const from = c.path ?? `${c.target}`
  return c.when ? `${toYaml(c.when, { flow: true }).trim()}: ${from}` : from
}

/**
 * Where a relation takes its target while nothing sets it on the entity: a
 * list of cases, tried in order. Each case may hold a condition on the entity
 * and gives a path to follow or one entity by key. One case with a path and
 * no condition is saved as a plain path.
 */
function InheritEditor({ def, onChange }: { def: RelationDef; onChange: (def: RelationDef) => void }) {
  // Rows keep an id of their own, so a row's half-typed condition stays with it as rows move; an empty row is kept here until it says something.
  const next = useRef(0)
  const [rows, setRows] = useState(() => inheritCases(def).map((c) => ({ id: next.current++, c })))
  const save = (list: { id: number; c: InheritCase }[]) => {
    setRows(list)
    const kept = list.map((r) => r.c).filter((c) => c.path || c.target)
    const only = kept[0]
    onChange({ ...def, inherit: !kept.length ? undefined : kept.length === 1 && only?.path && !only.when ? only.path : kept })
  }
  const move = (i: number, by: number) => {
    const list = [...rows]
    const [r] = list.splice(i, 1)
    list.splice(i + by, 0, r!)
    save(list)
  }
  return (
    <fieldset className="md:col-span-2 block" title="While nothing sets this relation on an entity, the first case it matches that reaches a target gives it. Set a team on a program and every service in it reads it; set one on a service and that wins there.">
      <legend>
        <Kicker>Inherit from</Kicker>
      </legend>
      <ol className="mt-1 space-y-2">
        {rows.map((r, i) => (
          <InheritCaseRow key={r.id} n={i + 1} c={r.c} target={def.target} first={i === 0} last={i === rows.length - 1} onChange={(c) => save(rows.map((x) => (x.id === r.id ? { id: r.id, c } : x)))} onMove={(by) => move(i, by)} onRemove={() => save(rows.filter((x) => x.id !== r.id))} />
        ))}
      </ol>
      <Button className="mt-2" onClick={() => save([...rows, { id: next.current++, c: { path: '' } }])}>
        <Plus className="size-3.5" aria-hidden /> Add a case
      </Button>
    </fieldset>
  )
}

function InheritCaseRow({ n, c, target, first, last, onChange, onMove, onRemove }: { n: number; c: InheritCase; target: string; first: boolean; last: boolean; onChange: (c: InheritCase) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const [when, setWhen] = useState(() => (c.when ? toYaml(c.when, { flow: true }).trim() : ''))
  const [bad, setBad] = useState<string | null>(null)
  const kind: 'path' | 'target' = c.target !== undefined ? 'target' : 'path'
  const commitWhen = () => {
    if (!when.trim()) {
      setBad(null)
      const { when: _gone, ...rest } = c
      onChange(rest)
      return
    }
    try {
      const parsed: unknown = parseYaml(when)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a condition is a filter, such as { field: type, op: eq, value: backend }')
      setBad(null)
      onChange({ ...c, when: parsed as Filter })
    } catch (error) {
      setBad(error instanceof Error ? error.message.split('\n')[0]! : String(error))
    }
  }
  return (
    <li className="rounded-md border border-ink-800 p-2" aria-label={`Case ${n}`}>
      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
        <label className="contents">
          <span className="text-[12px] text-ink-400">When</span>
          <input className={`${input} w-full font-mono`} value={when} onChange={(e) => setWhen(e.target.value)} onBlur={commitWhen} placeholder="always, or { field: type, op: eq, value: backend }" aria-invalid={!!bad} />
        </label>
        {bad && <span className="col-start-2 text-[12px] text-red">{bad}</span>}
        <label className="contents">
          <span className="text-[12px] text-ink-400">Take</span>
          <span className="flex gap-2">
            <select className={`${input} shrink-0`} value={kind} aria-label={`Case ${n}: take the target from`} onChange={(e) => onChange(e.target.value === 'target' ? { ...(c.when ? { when: c.when } : {}), target: '' } : { ...(c.when ? { when: c.when } : {}), path: '' })}>
              <option value="path">the end of a path</option>
              <option value="target">one {target}</option>
            </select>
            <input
              className={`${input} min-w-0 flex-1 font-mono`}
              aria-label={kind === 'path' ? `Case ${n}: path` : `Case ${n}: key of the ${target}`}
              value={(kind === 'path' ? c.path : c.target) ?? ''}
              onChange={(e) => onChange(kind === 'path' ? { ...c, path: e.target.value.trim() } : { ...c, target: e.target.value.trim() })}
              placeholder={kind === 'path' ? 'program.team, resource_group.environment' : 'its key'}
            />
          </span>
        </label>
      </div>
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" className="rounded-md p-1 text-ink-400 hover:bg-ink-800 disabled:opacity-40" disabled={first} onClick={() => onMove(-1)} aria-label={`Move case ${n} up`} title="Try this case earlier">
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" className="rounded-md p-1 text-ink-400 hover:bg-ink-800 disabled:opacity-40" disabled={last} onClick={() => onMove(1)} aria-label={`Move case ${n} down`} title="Try this case later">
          <ArrowDown className="size-3.5" />
        </button>
        <button type="button" className="rounded-md p-1 text-ink-400 hover:bg-red/10 hover:text-red" onClick={onRemove} aria-label={`Remove case ${n}`} title="Remove this case">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

/**
 * One relation, changed or added on its card. `name` null adds one, pointing
 * at `target`. Saving changes the blueprint at once.
 */
export function RelationPopover({ bp, all, name, target, anchor, onClose }: { bp: Blueprint; all: Blueprint[]; name: string | null; target: string; anchor: HTMLElement; onClose: () => void }) {
  const save = useSaveBlueprint()
  const [def, setDef] = useState<RelationDef>(() => (name ? structuredClone(bp.relations[name]!) : { target }))
  // A new relation is named after what it points at, until someone types a name of their own.
  const [typed, setTyped] = useState<string | null>(null)
  const newName = typed ?? [def.target, `${def.target}_2`, `${def.target}_3`].find((n) => !(n in bp.relations)) ?? ''
  const key = name ?? newName
  const named = !!name || (NAME.test(newName) && !(newName in bp.relations))
  const dirty = name ? JSON.stringify(def) !== JSON.stringify(bp.relations[name]) : true
  const changed = useChanged([def, typed])
  const to = all.find((b) => b.id === def.target)
  const blueprintName = useBlueprintName()
  return (
    <Popover anchor={anchor} width={460} onClose={onClose} onOutside={name && !dirty ? onClose : () => {}} unsaved={changed} label={name ? `Edit relation ${def.title || name}` : `New relation on ${blueprintName(bp)}`} className="max-h-[85vh] w-[460px] space-y-3 overflow-y-auto p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Kicker>{name ? 'Edit relation' : 'New relation'}</Kicker>
          <div className="truncate text-sm font-semibold">{def.title || key || 'Untitled'}</div>
          <div className="font-mono text-[12px] text-ink-400">
            {blueprintName(bp)} → {blueprintName(to ?? def.target)}
          </div>
        </div>
        <button className="-m-1.5 p-1.5 text-ink-500 hover:text-ink-100" title="Close without saving" aria-label="Close without saving" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {!name && (
        <label className="block">
          <Kicker>Name</Kicker>
          <input className={`${input} mt-1 w-full font-mono`} value={newName} onChange={(e) => setTyped(e.target.value.trim())} placeholder="relation_name" autoFocus />
          {newName && !named && <span className="mt-1 block text-[12px] text-ink-400">{newName in bp.relations ? 'Taken: pick another name.' : 'Lower case letters, digits, and underscores, starting with a letter.'}</span>}
        </label>
      )}
      <RelationForm def={def} all={all} onChange={setDef} />
      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button kind="solid" disabled={!dirty || !named || save.isPending} onClick={() => save.mutate({ id: bp.id, spec: { ...specOf(bp), relations: { ...bp.relations, [key]: def } } }, { onSuccess: onClose })}>
          {name ? 'Save' : 'Add relation'}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        {name && (
          <Button
            kind="danger"
            className="ml-auto"
            disabled={save.isPending}
            onClick={() => {
              if (!confirm(`Delete the relation ${bp.relations[name]?.title ?? name} from ${blueprintName(bp)}?`)) return
              const { [name]: _gone, ...relations } = bp.relations
              save.mutate({ id: bp.id, spec: { ...specOf(bp), relations } }, { onSuccess: onClose })
            }}
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
        )}
      </div>
    </Popover>
  )
}

function NewRelation({ all, target, existing, onAdd, onCancel }: { all: Blueprint[]; target: string; existing: string[]; onAdd: (name: string, def: RelationDef) => void; onCancel: () => void }) {
  const [name, setName] = useState(target)
  const [to, setTo] = useState(target)
  const [many, setMany] = useState(false)
  const [display, setDisplay] = useState<'link' | 'contain'>('link')
  useEscape(onCancel, useChanged([name, to, many, display]))
  const ok = NAME.test(name) && !existing.includes(name) && !!to
  return (
    <form
      className="grid grid-cols-1 gap-2 md:grid-cols-2 rounded-lg border border-orbit/40 bg-orbit/5 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) onAdd(name, { target: to, many: many || undefined, display: display === 'contain' ? 'contain' : undefined })
      }}
    >
      <input className={`${input} font-mono`} aria-label="Relation name" placeholder="relation_name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <select className={`${input} font-mono`} aria-label="Points at" value={to} onChange={(e) => setTo(e.target.value)}>
        {all.map((b) => (
          <option key={b.id} value={b.id}>
            → {b.id}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={many} disabled={display === 'contain'} onChange={(e) => setMany(e.target.checked)} /> many
      </label>
      <select className={input} aria-label="How it joins" value={display} onChange={(e) => (setDisplay(e.target.value as 'link' | 'contain'), e.target.value === 'contain' && setMany(false))}>
        <option value="link">line</option>
        <option value="contain">nest inside</option>
      </select>
      <div className="md:col-span-2 flex gap-2">
        <Button type="submit" kind="solid" disabled={!ok}>
          Add
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

/** The class a field is in, for an admin; null for anyone else, who is only told it is restricted. */
function useFieldClass(blueprint: string, name: string): FieldClass | null {
  const policy = usePolicy(useIsAdmin()).data?.policy
  return policy ? classFor(policy, blueprint, name) : null
}
