import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { ownsPaths, type AccessGrant, type AccessRule, type OwnerAccess } from '../../shared/model.ts'
import { useAccessSettings, useBlueprints, useIsAdmin, usePolicy } from '../api.ts'
import { Badge, Button, input, Kicker } from './ui.tsx'

/**
 * Who may see a blueprint or a field: named audiences from the access policy,
 * and a list of grants, any one of which lets a person in. A grant follows a path from the signed-in person's own entity
 * and compares what it reads there, so it can name teams, a department,
 * people by address, or any other value a person carries. An admin and a
 * machine token see everything regardless. Only an admin sees or sets this.
 * With `adminsByDefault`, no grants means only admins see it; with `open`,
 * no grants is said that way instead of as everyone who signs in. With
 * `ownerFields`, the fields of a blueprint, it also opens each entity to the
 * people who own it. With `relations`, a blueprint's relations, it also opens
 * each entity to whoever sees what it is about.
 */
export function AccessEditor({ value, onChange, what, adminsByDefault = false, open, ownerFields, relations }: { value: AccessRule | undefined; onChange: (rule: AccessRule | undefined) => void; what: string; adminsByDefault?: boolean; open?: string; ownerFields?: string[]; relations?: string[] }) {
  const grants = value?.grants ?? []
  const audiences = value?.audiences ?? []
  const owners = value?.owners
  const subjects = value?.subjects
  const build = (g: AccessGrant[], a: string[], o: OwnerAccess | undefined, s: string[] | undefined = subjects) => onChange(g.length || a.length || o || s?.length ? { grants: g, ...(a.length ? { audiences: a } : {}), ...(o ? { owners: o } : {}), ...(s?.length ? { subjects: s } : {}) } : undefined)
  const emit = (g: AccessGrant[], a: string[]) => build(g, a, owners)
  const set = (next: AccessGrant[]) => emit(next, audiences)
  const update = (i: number, patch: Partial<AccessGrant>) => set(grants.map((g, j) => (j === i ? clean({ ...g, ...patch }) : g)))
  const paths = usePersonPaths()
  const policy = usePolicy(useIsAdmin()).data?.policy
  const known = policy?.audiences ?? []
  const free = known.filter((a) => !audiences.includes(a.id))
  const titleOf = (id: string) => known.find((a) => a.id === id)?.title ?? id
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-ink-400">{grants.length || audiences.length ? `Only these people see ${what}, plus every admin. Anyone in an audience, or matching one line, gets in.` : adminsByDefault ? `Only admins see ${what}.` : (open ?? `Everyone who signs in sees ${what}.`)}</div>
      {(audiences.length > 0 || free.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {audiences.map((id) => (
            <Badge key={id} title={known.find((a) => a.id === id)?.description}>
              {titleOf(id)}
              <button type="button" className="ml-1 rounded-sm text-ink-400 hover:text-red" aria-label={`Take out the ${titleOf(id)} audience`} onClick={() => emit(grants, audiences.filter((a) => a !== id))}>
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          {free.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-400">
              <span className="sr-only">Add an audience</span>
              <select className={`${input} py-1 text-[12px]`} value="" onChange={(e) => e.target.value && emit(grants, [...audiences, e.target.value])}>
                <option value="">Add an audience…</option>
                {free.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {grants.map((g, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_2fr_auto] items-end gap-2">
          <label className="block" title="Relations to follow from the person, one hop per dot: team, department, team.department. Empty means the person themselves">
            <Kicker>Their</Kicker>
            <input className={`${input} mt-1 w-full font-mono`} value={g.path ?? ''} placeholder="team" onChange={(e) => update(i, { path: e.target.value.trim() || undefined })} />
          </label>
          <label className="block" title="The field to read where the path ends. Empty reads the key and the title">
            <Kicker>Field</Kicker>
            <input className={`${input} mt-1 w-full font-mono`} value={g.field ?? ''} placeholder="key or title" onChange={(e) => update(i, { field: e.target.value.trim() || undefined })} />
          </label>
          <label className="block" title="Comma separated. Matching ignores case">
            <Kicker>Is one of</Kicker>
            <ValuesInput values={g.values} placeholder={g.path ? 'platform-engineering, human-resources' : 'someone@example.org'} onChange={(values) => update(i, { values })} />
          </label>
          <button type="button" className="mb-1 rounded-sm p-1 text-ink-500 hover:bg-ink-700 hover:text-red" title="Remove this line" onClick={() => set(grants.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {ownerFields && (grants.length > 0 || audiences.length > 0 || owners) && <OwnersEditor value={owners} fields={ownerFields} onChange={(o) => build(grants, audiences, o)} />}
      {relations && relations.length > 0 && (grants.length > 0 || audiences.length > 0 || owners || subjects) && <SubjectsEditor value={subjects ?? []} relations={relations} onChange={(s) => build(grants, audiences, owners, s)} />}
      <div className="flex flex-wrap gap-2">
        {paths.map((p) => (
          <Button key={p.path} onClick={() => set([...grants, { path: p.path, values: [] }])} title={`Match on the person's ${p.path} relation`}>
            <Plus className="mr-1 inline size-3" />
            {p.title}
          </Button>
        ))}
        <Button onClick={() => set([...grants, { values: [] }])}>
          <Plus className="mr-1 inline size-3" />
          People
        </Button>
      </div>
    </div>
  )
}

/**
 * Who else sees the entities of a blueprint: the people who own one, by the
 * roles of the person setting's `owns`, each seeing only their own, with the
 * fields named or every field no rule or class keeps from them.
 */
/** The relations that name what each entity is about: whoever sees an entity at the far end of one sees this one too. */
function SubjectsEditor({ value, relations, onChange }: { value: string[]; relations: string[]; onChange: (s: string[]) => void }) {
  return (
    <div className="space-y-2 rounded-sm border border-ink-800 p-2">
      <div className="text-[12px] text-ink-300">Whoever sees what one is about sees it too, through these relations. They never change it.</div>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-400">
        {relations.map((r) => (
          <label key={r} className="inline-flex items-center gap-1 font-mono">
            <input type="checkbox" checked={value.includes(r)} onChange={() => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r])} />
            {r}
          </label>
        ))}
      </div>
    </div>
  )
}

function OwnersEditor({ value, fields, onChange }: { value: OwnerAccess | undefined; fields: string[]; onChange: (o: OwnerAccess | undefined) => void }) {
  const roles = [...new Set(ownsPaths(useAccessSettings().data?.person?.owns).flatMap((p) => (p.as ? [p.as] : [])))].sort()
  const listed = value && Array.isArray(value.fields) ? value.fields : []
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
  return (
    <div className="space-y-2 rounded-sm border border-ink-800 p-2">
      <label className="flex items-center gap-2 text-[12px] text-ink-300">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { roles: roles.includes('owner') ? ['owner'] : roles.slice(0, 1), fields: [] } : undefined)} />
        The people who own one see it too: their own, and nothing else of this blueprint. They never change it.
      </label>
      {value && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-400">
            <span>Owning as</span>
            {roles.map((r) => (
              <label key={r} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={value.roles.includes(r)} onChange={() => onChange({ ...value, roles: toggle(value.roles, r).length ? toggle(value.roles, r) : value.roles })} />
                {r}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-400">
            <label className="inline-flex items-center gap-1">
              <input type="radio" checked={value.fields !== 'all'} onChange={() => onChange({ ...value, fields: [] })} />
              Only the fields picked here
            </label>
            <label className="inline-flex items-center gap-1">
              <input type="radio" checked={value.fields === 'all'} onChange={() => onChange({ ...value, fields: 'all' })} />
              Every field no rule or class keeps from them
            </label>
          </div>
          {value.fields !== 'all' && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-300">
              {fields.map((f) => (
                <label key={f} className="inline-flex items-center gap-1 font-mono">
                  <input type="checkbox" checked={listed.includes(f)} onChange={() => onChange({ ...value, fields: toggle(listed, f) })} />
                  {f}
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The relations a grant can start from: the ones the person blueprint really has, so a quick-add line
 * always names a path that resolves. Nothing is offered until the hub knows which blueprint holds people.
 */
function usePersonPaths(): { path: string; title: string }[] {
  const person = useAccessSettings().data?.person?.blueprint
  const bp = useBlueprints().data?.blueprints.find((b) => b.id === person)
  if (!bp) return []
  return Object.entries(bp.relations).map(([path, rel]) => ({ path, title: rel.title ?? path }))
}

function clean(g: AccessGrant): AccessGrant {
  return { ...(g.path ? { path: g.path } : {}), ...(g.field ? { field: g.field } : {}), values: g.values }
}

/** Values typed comma separated. The text is kept as typed, so a comma stays while the next value is still empty. */
function ValuesInput({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(() => values.join(', '))
  return (
    <input
      className={`${input} mt-1 w-full font-mono`}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))
      }}
    />
  )
}
