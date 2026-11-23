import { Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { classFor, POLICY_ID, type AccessPolicy, type Audience, type FieldClass } from '../../shared/policy.ts'
import type { FieldCoverage, PolicyPreview, PostureItem, PostureResponse, PostureTarget, PostureTeam } from '../../shared/posture.ts'
import { useAccessSettings, useEntities, usePolicyChange } from '../api.ts'
import { Picker, type PickerOption } from './Picker.tsx'
import { AccessEditor } from './AccessEditor.tsx'
import { Drawer } from './Drawer.tsx'
import { Badge, Button, ErrorNote, input, Kicker, Panel } from './ui.tsx'
import { plural } from './security-words.ts'

/** What the policy drawer edits: one audience or one class, new or as saved. */
export type PolicyEdit = { kind: 'audience'; id: string | null; seed?: Partial<Audience> } | { kind: 'class'; id: string | null; seed?: Partial<FieldClass> }

const COVERAGE: { id: FieldCoverage; label: string; note: string; color: string }[] = [
  { id: 'classified', label: 'In a class', note: 'a class decides who sees them', color: 'var(--color-green)' },
  { id: 'ruled', label: 'Own rule', note: 'a rule on the field decides', color: 'var(--color-v-blue)' },
  { id: 'reviewed', label: 'Open, reviewed', note: 'an admin looked and left them open', color: 'var(--color-ink-400)' },
  { id: 'unreviewed', label: 'Open, not reviewed', note: 'open because nobody decided', color: 'var(--color-amber)' },
]

/**
 * The policy at a glance: how every field's reach was decided, the audiences
 * with whom they let in and what names them, the classes with what they
 * cover, and the grants written out by hand that could be an audience.
 */
export function Overview({ data, onEdit, onTarget }: { data: PostureResponse; onEdit: (e: PolicyEdit) => void; onTarget: (t: PostureTarget) => void }) {
  const git = data.policy.source
  const total = Object.values(data.coverage).reduce((a, b) => a + b, 0)
  return (
    <div className="space-y-6">
      <Panel className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-[15px] font-medium text-ink-100">How every field's reach was decided</h2>
          <span className="text-[12px] text-ink-400">{total} fields</span>
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-sm bg-ink-850" role="img" aria-label={COVERAGE.map((c) => `${c.label}: ${data.coverage[c.id]}`).join(', ')}>
          {COVERAGE.map((c) => (data.coverage[c.id] ? <div key={c.id} style={{ width: `${(100 * data.coverage[c.id]) / Math.max(total, 1)}%`, background: c.color }} /> : null))}
        </div>
        <ul className="grid grid-cols-2 gap-3 text-[12px] md:grid-cols-4">
          {COVERAGE.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              <span className="mt-1 inline-block size-2.5 shrink-0 rounded-sm" style={{ background: c.color }} aria-hidden />
              <span>
                <span className="text-ink-100">
                  {c.label}: <span className="tabular-nums">{data.coverage[c.id]}</span>
                </span>
                <span className="block text-ink-400">{c.note}</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      {git && (
        <p className="rounded-md border border-edge px-3 py-2 text-sm text-ink-300">
          The audiences and classes are declared in git by source <span className="font-mono">{git}</span>. Change them there; the hub reads them on its next pass.
        </p>
      )}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium text-ink-100">Audiences</h2>
          <span className="text-[12px] text-ink-400">Who: named people, and the grants and audiences they hold. A rule or a class names them.</span>
          {!git && (
            <Button kind="solid" opens="dialog" className="ml-auto" onClick={() => onEdit({ kind: 'audience', id: null })}>
              <Plus className="mr-1 inline size-3.5" aria-hidden />
              New audience
            </Button>
          )}
        </div>
        {data.audiences.length ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {data.audiences.map((a) => {
              const def = data.policy.policy.audiences.find((x) => x.id === a.id)!
              const count = (k: PostureTarget['kind']) => a.targets.filter((t) => t.kind === k).length
              return (
                <li key={a.id}>
                  <Panel className="h-full space-y-2 px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] font-medium text-ink-100">{a.title}</h3>
                        {a.description && <p className="text-[12px] text-ink-400">{a.description}</p>}
                      </div>
                      {!git && <Button opens="dialog" onClick={() => onEdit({ kind: 'audience', id: a.id })}>Edit</Button>}
                    </div>
                    <div className="text-[12px] text-ink-400">
                      {plural(a.members.length, 'person', 'people')} today
                      {def.audiences.length > 0 && <> · holds {def.audiences.map((id) => titleOf(data, id)).join(', ')}</>}
                      {a.heldBy.length > 0 && <> · inside {a.heldBy.map((id) => titleOf(data, id)).join(', ')}</>}
                      {def.grants.length > 0 && <> · {plural(def.grants.length, 'grant')}</>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">{a.members.length ? a.members.map((m) => <Badge key={m}>{m}</Badge>) : <span className="text-sm text-amber">Nobody is in it today.</span>}</div>
                    {a.strangers.length > 0 && <p className="text-[12px] text-amber">Names people the hub does not know: {a.strangers.join(', ')}</p>}
                    <div className="text-[12px] text-ink-300">
                      Opens {plural(count('blueprint'), 'blueprint')}, {plural(count('field'), 'field')}, {plural(count('action'), 'action')}
                      {a.classes.length > 0 && <>, and the {a.classes.map((id) => data.classes.find((c) => c.id === id)?.title ?? id).join(', ')} {a.classes.length === 1 ? 'class' : 'classes'}</>}
                    </div>
                  </Panel>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-400">No audiences yet. Name one for each group of people you share with, then point rules at it instead of writing grants out by hand.</p>
        )}
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium text-ink-100">Classes</h2>
          <span className="text-[12px] text-ink-400">What kind of data: a class covers matching fields on every blueprint, now and later.</span>
          {!git && (
            <Button kind="solid" opens="dialog" className="ml-auto" disabled={!data.audiences.length} title={data.audiences.length ? undefined : 'A class names an audience: make one first'} onClick={() => onEdit({ kind: 'class', id: null })}>
              <Plus className="mr-1 inline size-3.5" aria-hidden />
              New class
            </Button>
          )}
        </div>
        {data.classes.length ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {data.classes.map((c) => {
              const def = data.policy.policy.classes.find((x) => x.id === c.id)!
              const blueprints = new Set(c.fields.map((f) => f.blueprint))
              return (
                <li key={c.id}>
                  <Panel className="h-full space-y-2 px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] font-medium text-ink-100">{c.title}</h3>
                        {c.description && <p className="text-[12px] text-ink-400">{c.description}</p>}
                      </div>
                      {!git && <Button opens="dialog" onClick={() => onEdit({ kind: 'class', id: c.id })}>Edit</Button>}
                    </div>
                    <div className="text-[12px] text-ink-300">
                      Seen by {c.audiences.map((id) => titleOf(data, id)).join(' and ')}
                      {def.owned && <>, and by their owners on what they own{def.owned.through.length > 0 && ` or own through ${def.owned.through.join(', ')}`}</>} · {plural(c.fields.length, 'field')} on {plural(blueprints.size, 'blueprint')}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {def.match.map((m) => (
                        <code key={m} className="rounded-sm bg-ink-850 px-1.5 py-0.5 font-mono text-[12px] text-ink-200">
                          {m}
                        </code>
                      ))}
                      {def.include.length > 0 && <span className="text-[12px] text-ink-400">+ {plural(def.include.length, 'named field')}</span>}
                      {def.exclude.length > 0 && <span className="text-[12px] text-ink-400">− {plural(def.exclude.length, 'field')} left out</span>}
                    </div>
                    {c.setAside.length > 0 && <p className="text-[12px] text-amber">Sets aside {plural(c.setAside.length, 'rule')} written on its fields: see the findings.</p>}
                  </Panel>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-400">No classes yet. A class such as Cost hides every matching field from everyone outside its audiences, the same way on every blueprint.</p>
        )}
      </section>
      {data.teams.length > 0 && (
        <details className="rounded-md border border-ink-800">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-ink-100">Grants written out by hand ({data.teams.length})</summary>
          <p className="px-4 pb-2 text-[12px] text-ink-400">Each value a rule grants to directly. One that appears on many rules is an audience without a name: make it one, then point those rules at it.</p>
          <ul className="divide-y divide-ink-800 border-t border-ink-800">
            {data.teams.map((t) => (
              <TeamRow key={t.id} team={t} git={!!git} onEdit={onEdit} onTarget={onTarget} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function TeamRow({ team, git, onEdit, onTarget }: { team: PostureTeam; git: boolean; onEdit: (e: PolicyEdit) => void; onTarget: (t: PostureTarget) => void }) {
  const seed: Partial<Audience> = team.grant.path || team.grant.field ? { grants: [team.grant] } : { people: team.grant.values }
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <button type="button" className="min-w-0 flex-1 text-left text-ink-100 hover:underline" onClick={() => team.targets[0] && onTarget(team.targets[0])}>
        {team.words}
      </button>
      <span className="text-[12px] text-ink-400">
        {plural(team.members.length, 'person', 'people')} · on {plural(team.targets.length, 'rule')}
      </span>
      {!git && (
        <Button opens="dialog" onClick={() => onEdit({ kind: 'audience', id: null, seed })}>
          Make an audience
        </Button>
      )}
    </li>
  )
}

/**
 * Edits one audience or class inside a copy of the whole policy, previews who
 * gains and loses sight of what, and saves the policy. Removing one is a
 * change like any other, with its own preview.
 */
export function PolicyDrawer({ data, edit, onClose }: { data: PostureResponse; edit: PolicyEdit; onClose: () => void }) {
  const saved = data.policy.policy
  const [audience, setAudience] = useState<Audience>(() => {
    const was = edit.kind === 'audience' && edit.id ? saved.audiences.find((a) => a.id === edit.id) : undefined
    return was ? structuredClone(was) : { id: '', title: '', people: [], grants: [], audiences: [], ...(edit.kind === 'audience' ? edit.seed : {}) }
  })
  const [cls, setCls] = useState<FieldClass>(() => {
    const was = edit.kind === 'class' && edit.id ? saved.classes.find((c) => c.id === edit.id) : undefined
    return was ? structuredClone(was) : { id: '', title: '', audiences: [], match: [], include: [], exclude: [], ...(edit.kind === 'class' ? edit.seed : {}) }
  })
  const [removing, setRemoving] = useState(false)
  const [preview, setPreview] = useState<PolicyPreview | null>(null)
  const change = usePolicyChange()
  const next = useMemo((): AccessPolicy => {
    if (edit.kind === 'audience') {
      const rest = saved.audiences.filter((a) => a.id !== edit.id)
      // A removed audience comes out of everything that holds it, so nothing is left naming one that is gone.
      const audiences = removing ? rest.map((a) => ({ ...a, audiences: a.audiences.filter((x) => x !== edit.id) })) : edit.id ? saved.audiences.map((a) => (a.id === edit.id ? audience : a)) : [...saved.audiences, audience]
      // An edit rule lets go of a removed audience the same way.
      return { audiences, classes: saved.classes, edits: removing ? saved.edits.map((r) => ({ ...r, audiences: r.audiences.filter((x) => x !== edit.id) })) : saved.edits }
    }
    const classes = removing ? saved.classes.filter((c) => c.id !== edit.id) : edit.id ? saved.classes.map((c) => (c.id === edit.id ? cls : c)) : [...saved.classes, cls]
    return { audiences: saved.audiences, classes, edits: saved.edits }
  }, [edit, saved, audience, cls, removing])
  const run = async (save: boolean) => {
    const result = await change.mutateAsync({ policy: next, save })
    setPreview(result)
    if (result.saved) onClose()
  }
  // Every change is previewed on its own a moment after typing stops, so Save is ready as soon as the preview is; an answer for an older draft is dropped.
  const draft = JSON.stringify(next)
  const named = edit.kind === 'audience' ? audience : cls
  const idTaken = !edit.id && (edit.kind === 'audience' ? saved.audiences : saved.classes).some((x) => x.id === named.id)
  const ready = removing || (!!named.id && !idTaken)
  const changed = removing || draft !== JSON.stringify(saved)
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const preview2 = usePolicyChange()
  useEffect(() => {
    if (!ready || !changed) return
    const at = draft
    const timer = setTimeout(() => {
      preview2.mutateAsync({ policy: JSON.parse(at) as AccessPolicy, save: false }).then(
        (result) => {
          if (latest.current !== at) return
          setPreview(result)
          setPreviewFor(at)
        },
        () => {},
      )
    }, 400)
    return () => clearTimeout(timer)
  }, [draft, ready, changed])
  const latest = useRef(draft)
  latest.current = draft
  const current = preview && previewFor === draft ? preview : null
  const what = edit.kind === 'audience' ? 'audience' : 'class'
  return (
    <Drawer title={edit.id ? `${named.title || edit.id}` : `New ${what}`} subtitle={edit.kind === 'audience' ? 'Audience' : 'Class'} icon={<ShieldCheck className="size-4" aria-hidden />} onClose={onClose} unsaved={changed} width={680}>
      <div className="space-y-5 p-4">
        {!removing && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <Kicker>Title</Kicker>
                <input
                  className={`${input} mt-1 w-full`}
                  value={named.title}
                  onChange={(e) => {
                    const title = e.target.value
                    const id = edit.id ? named.id : slug(title)
                    if (edit.kind === 'audience') setAudience((a) => ({ ...a, title, id }))
                    else setCls((c) => ({ ...c, title, id }))
                  }}
                />
              </label>
              <label className="block">
                <Kicker>Id</Kicker>
                <input className={`${input} mt-1 w-full font-mono`} value={named.id} disabled={!!edit.id} title={edit.id ? 'Rules name it by its id, so it does not change' : undefined} onChange={(e) => (edit.kind === 'audience' ? setAudience((a) => ({ ...a, id: e.target.value })) : setCls((c) => ({ ...c, id: e.target.value })))} />
                {named.id && !POLICY_ID.test(named.id) && <span className="text-[12px] text-amber">Lowercase letters, digits, - and _, starting with a letter.</span>}
                {idTaken && <span className="text-[12px] text-amber">Another {what} has this id.</span>}
              </label>
            </div>
            <label className="block">
              <Kicker>Description</Kicker>
              <input className={`${input} mt-1 w-full`} value={named.description ?? ''} placeholder={edit.kind === 'audience' ? 'Who they are, and why they share what they see' : 'What this data is, and why it is held close'} onChange={(e) => (edit.kind === 'audience' ? setAudience((a) => ({ ...a, description: e.target.value })) : setCls((c) => ({ ...c, description: e.target.value })))} />
            </label>
            {edit.kind === 'audience' ? <AudienceForm data={data} value={audience} onChange={(a) => (setAudience(a))} /> : <ClassForm data={data} policy={next} value={cls} onChange={(c) => (setCls(c))} />}
          </>
        )}
        {removing && <p className="text-sm text-ink-300">Remove the {named.title} {what}. {edit.kind === 'audience' ? 'Every rule and class that names it lets its people in no more, and audiences that hold it let go of it.' : 'Its fields go back to their own rules, and to open where they have none.'}</p>}
        <ErrorNote error={change.error} />
        <div className="flex flex-wrap gap-2">
          <Button kind={removing ? 'danger' : 'solid'} onClick={() => void run(true)} disabled={!current || current.problems.length > 0 || change.isPending} title={current ? undefined : changed ? 'Working out who gains and loses' : 'Nothing has changed yet'}>
            {removing ? `Remove the ${what}` : 'Save'}
          </Button>
          {edit.id && (
            <Button kind={removing ? 'ghost' : 'danger'} className="ml-auto" onClick={() => setRemoving((r) => !r)}>
              {removing ? 'Keep it' : (
                <>
                  <Trash2 className="mr-1 inline size-3.5" aria-hidden />
                  Remove
                </>
              )}
            </Button>
          )}
        </div>
        <ErrorNote error={preview2.error} />
        {current ? <PolicyPreviewList preview={current} /> : changed && ready && <p className="text-sm text-ink-400" aria-live="polite">Working out who gains and loses…</p>}
      </div>
    </Drawer>
  )
}

function AudienceForm({ data, value, onChange }: { data: PostureResponse; value: Audience; onChange: (a: Audience) => void }) {
  const people = usePeople(data)
  const nameOf = (address: string) => people.find((p) => p.id === address)?.label
  const add = (address: string | null) => address && onChange({ ...value, people: [...new Set([...value.people, address.toLowerCase()])] })
  return (
    <>
      <div className="space-y-2">
        <Kicker>People</Kicker>
        <p className="text-[12px] text-ink-400">Name people one by one. A change to a team elsewhere never moves them in or out.</p>
        <div className="flex flex-wrap gap-1.5">
          {value.people.map((p) => (
            <Badge key={p} title={p}>
              {nameOf(p) ?? p}
              <button type="button" className="ml-1 rounded-sm text-ink-400 hover:text-red" aria-label={`Take out ${p}`} onClick={() => onChange({ ...value, people: value.people.filter((x) => x !== p) })}>
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          {!value.people.length && <span className="text-sm text-ink-500">Nobody named.</span>}
        </div>
        <Picker
          label="Add a person"
          options={people.filter((p) => !value.people.includes(p.id))}
          value={null}
          placeholder="Type a name or an address"
          onChange={add}
          typed={(q) => (/^[^\s@]+@[^\s@]+$/.test(q) ? { id: q.toLowerCase(), label: `Add ${q.toLowerCase()}`, note: 'nobody in the catalog answers to this address yet', group: 'Not in the catalog' } : null)}
        />
      </div>
      <div className="space-y-2 rounded-md border border-ink-800 p-3">
        <Kicker>Everyone these let in, now and later</Kicker>
        <p className="text-[12px] text-ink-400">Hold another audience, or grant by a team or department, only when everyone in it belongs here for good.</p>
        <AccessEditor value={{ grants: value.grants, audiences: value.audiences }} onChange={(rule) => onChange({ ...value, grants: rule?.grants ?? [], audiences: (rule?.audiences ?? []).filter((x) => x !== value.id) })} what="this audience's share" />
      </div>
    </>
  )
}

function ClassForm({ data, policy, value, onChange }: { data: PostureResponse; policy: AccessPolicy; value: FieldClass; onChange: (c: FieldClass) => void }) {
  const fields = data.items.filter((i): i is PostureItem & { target: { kind: 'field'; blueprint: string; field: string } } => i.target.kind === 'field')
  const covered = fields.filter((f) => classFor(policy, f.target.blueprint, f.target.field)?.id === value.id)
  const byBlueprint = new Map<string, string[]>()
  for (const f of covered) byBlueprint.set(f.target.blueprint, [...(byBlueprint.get(f.target.blueprint) ?? []), f.target.field])
  return (
    <>
      <fieldset className="space-y-1.5">
        <legend>
          <Kicker>Seen by</Kicker>
        </legend>
        {policy.audiences.map((a) => (
          <label key={a.id} className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={value.audiences.includes(a.id)} onChange={(e) => onChange({ ...value, audiences: e.target.checked ? [...value.audiences, a.id] : value.audiences.filter((x) => x !== a.id) })} />
            {a.title}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <Kicker>Field names</Kicker>
          <ListArea className="h-24" value={value.match} placeholder={'cost_*\n*_cents'} onChange={(match) => onChange({ ...value, match })} />
          <span className="text-[12px] text-ink-400">One pattern a line; * stands for anything.</span>
        </label>
        <label className="block">
          <Kicker>Only on blueprints</Kicker>
          <ListArea className="h-24" value={value.blueprints ?? []} placeholder="Every blueprint" onChange={(blueprints) => onChange({ ...value, blueprints })} />
          <span className="text-[12px] text-ink-400">Blueprint ids or patterns; empty is every blueprint.</span>
        </label>
      </div>
      <label className="block">
        <Kicker>Also these fields</Kicker>
        <ListArea className="h-16" value={value.include} placeholder="project.budget" onChange={(include) => onChange({ ...value, include })} />
      </label>
      <div className="space-y-2">
        <Kicker>Left out</Kicker>
        {value.exclude.map((x, i) => (
          <div key={i} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
            <input className={`${input} font-mono`} aria-label="Field to leave out, as blueprint.field" value={x.field} onChange={(e) => onChange({ ...value, exclude: value.exclude.map((y, j) => (j === i ? { ...y, field: e.target.value.trim() } : y)) })} />
            <input className={input} aria-label="Why it is left out" placeholder="Why" value={x.reason} onChange={(e) => onChange({ ...value, exclude: value.exclude.map((y, j) => (j === i ? { ...y, reason: e.target.value } : y)) })} />
            <button type="button" className="mb-1 rounded-sm p-1 text-ink-500 hover:bg-ink-700 hover:text-red" aria-label="Keep this field in the class" onClick={() => onChange({ ...value, exclude: value.exclude.filter((_, j) => j !== i) })}>
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <Button onClick={() => onChange({ ...value, exclude: [...value.exclude, { field: '', reason: '' }] })}>
          <Plus className="mr-1 inline size-3" aria-hidden />
          Leave a field out
        </Button>
      </div>
      <fieldset className="space-y-2">
        <legend>
          <Kicker>Owners see it too</Kicker>
        </legend>
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={!!value.owned} onChange={(e) => onChange(e.target.checked ? { ...value, owned: { through: [], roles: [] } } : withoutOwned(value))} />
          Show these fields on what a person owns, and nowhere else
        </label>
        {value.owned && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <Kicker>Or owns through</Kicker>
              <ListArea className="h-16" value={value.owned.through} placeholder="program" onChange={(through) => onChange({ ...value, owned: { ...value.owned!, through } })} />
              <span className="text-[12px] text-ink-400">Relations of the entity, one a line: owning what it points at opens it too.</span>
            </label>
            <label className="block">
              <Kicker>Owning as</Kicker>
              <ListArea className="h-16" value={value.owned.roles} placeholder="Any way" onChange={(roles) => onChange({ ...value, owned: { ...value.owned!, roles } })} />
              <span className="text-[12px] text-ink-400">Roles from what a person owns, such as program; empty is any.</span>
            </label>
          </div>
        )}
      </fieldset>
      <div className="space-y-2">
        <Kicker>
          Covers {plural(covered.length, 'field')} on {plural(byBlueprint.size, 'blueprint')}
        </Kicker>
        <ul className="max-h-64 divide-y divide-ink-800 overflow-y-auto rounded-md border border-ink-800 text-sm">
          {[...byBlueprint].map(([bp, names]) => (
            <li key={bp} className="flex flex-wrap gap-x-3 px-3 py-1.5">
              <span className="font-mono text-[12px] text-ink-100">{bp}</span>
              <span className="font-mono text-[12px] text-ink-400">{names.join(', ')}</span>
            </li>
          ))}
          {!covered.length && <li className="px-3 py-2 text-ink-400">No field matches yet.</li>}
        </ul>
      </div>
    </>
  )
}

function withoutOwned({ owned: _o, ...rest }: FieldClass): FieldClass {
  return rest
}

/** A list typed one item a line. The text is kept as typed, so a new line stays while it is still empty. */
function ListArea({ value, onChange, placeholder, className }: { value: string[]; onChange: (list: string[]) => void; placeholder: string; className: string }) {
  const [text, setText] = useState(() => value.join('\n'))
  return (
    <textarea
      className={`${input} mt-1 w-full font-mono ${className}`}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))
      }}
    />
  )
}

export function PolicyPreviewList({ preview }: { preview: PolicyPreview }) {
  if (preview.problems.length)
    return (
      <div className="space-y-1" aria-live="polite">
        <Kicker>Cannot be saved</Kicker>
        <ul className="list-disc pl-5 text-sm text-amber">
          {preview.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    )
  const names = (list: string[]) => (list.length ? list.join(', ') : 'nobody')
  return (
    <div className="space-y-2" aria-live="polite">
      <Kicker>{preview.saved ? 'Saved' : 'If you save'}</Kicker>
      {preview.items.length ? (
        <ul className="max-h-96 divide-y divide-ink-800 overflow-y-auto rounded-md border border-ink-800">
          {preview.items.map((i) => (
            <li key={`${i.target.kind}:${i.title}`} className="space-y-0.5 px-3 py-2 text-sm">
              <div className="font-medium text-ink-100">{i.title}</div>
              {i.gains.length > 0 && (
                <div className="text-ink-300">
                  <span className="text-green">Gains:</span> {names(i.gains)}
                </div>
              )}
              {i.loses.length > 0 && (
                <div className="text-ink-300">
                  <span className="text-red">Loses:</span> {names(i.loses)}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-400">Nobody gains or loses sight of anything.</p>
      )}
    </div>
  )
}

function titleOf(data: PostureResponse, id: string): string {
  return data.policy.policy.audiences.find((a) => a.id === id)?.title ?? id
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64)
}


/**
 * Everyone an audience may name: each person in the person blueprint by name,
 * with their sign-in address, and the hub's machine tokens, which run
 * actions by name.
 */
function usePeople(data: PostureResponse): PickerOption[] {
  const person = useAccessSettings().data?.person
  const list = useEntities(person?.blueprint ?? '', new URLSearchParams({ limit: '2000' }), !!person).data?.entities
  return useMemo(() => {
    const out = new Map<string, PickerOption>()
    for (const e of list ?? []) {
      const raw = person?.field ? e.fields[person.field] : e.key
      const address = typeof raw === 'string' && raw.includes('@') ? raw.toLowerCase() : null
      if (address) out.set(address, { id: address, label: e.title || address, note: address, group: 'People' })
    }
    for (const p of data.principals) {
      if (out.has(p.name)) continue
      out.set(p.name, p.kind === 'token' ? { id: p.name, label: p.name, note: 'machine token', group: 'Tokens' } : { id: p.name, label: p.name, note: 'signed in, with no person entity', group: 'People' })
    }
    const rank = (o: PickerOption) => (o.group === 'People' ? 0 : 1)
    return [...out.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
  }, [list, person, data.principals])
}
