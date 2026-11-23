// The Who edits tab: who changes each value by hand, in four numbers a
// blueprint, the edit rules that open values to owners and audiences, what
// they open to one person, and the hand values standing over a source's.

import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { ownsPaths, SELF_ROLE } from '../../shared/model.ts'
import { POLICY_ID, type AccessPolicy, type EditRule } from '../../shared/policy.ts'
import { EDIT_AUTHORITIES, type EditAuthority, type EditBlueprint, type EditsResponse, type PostureResponse } from '../../shared/posture.ts'
import { useAccessSettings, useBlueprints, useEdits, usePolicyChange } from '../api.ts'
import { ago, short, words } from '../format.ts'
import { Drawer } from './Drawer.tsx'
import { Picker } from './Picker.tsx'
import { AUTHORITY, narrowed, reachWords, ruleOpens, ruleWho, totals } from './security-edits.ts'
import { plural } from './security-words.ts'
import { Badge, Button, ErrorNote, input, Kicker, Link, Panel } from './ui.tsx'

/** The authorities a person decides: the hub's own working out is said beside them, never as a column. */
const SHOWN: EditAuthority[] = EDIT_AUTHORITIES.filter((a) => a !== 'derived')

export function WhoEdits({ data }: { data: PostureResponse }) {
  const [person, setPerson] = useState<string | null>(null)
  const edits = useEdits(person)
  const [only, setOnly] = useState<EditAuthority | null>(null)
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string | null } | null>(null)
  const policy = data.policy.policy
  const git = data.policy.source
  const people = useMemo(() => data.principals.filter((p) => p.kind === 'person').map((p) => ({ id: p.name, label: p.name, note: p.admin ? 'Admin' : p.roles.join(', ') || 'No role' })), [data])
  const all = edits.data?.blueprints ?? []
  const sum = useMemo(() => totals(all), [all])
  const shown = useMemo(() => narrowed(all, text, only), [all, text, only])
  const titleOf = (id: string) => all.find((b) => b.id === id)?.title ?? id
  return (
    <div className="space-y-6">
      <ErrorNote error={edits.error} />
      <section aria-label="Who changes a value by hand">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SHOWN.map((a) => (
            <button key={a} type="button" aria-pressed={only === a} onClick={() => setOnly(only === a ? null : a)} title={AUTHORITY[a].note} className={`rounded-lg border px-4 py-3 text-left ${only === a ? 'border-ink-300 bg-ink-850' : 'border-ink-700 bg-ink-900/70 hover:border-ink-500'}`}>
              <div className="label">{AUTHORITY[a].label}</div>
              <div className="mt-1 text-2xl font-semibold text-ink-50 tabular-nums">{edits.data ? sum[a].toLocaleString() : '…'}</div>
              <div className="text-[12px] text-ink-400">{AUTHORITY[a].note}</div>
            </button>
          ))}
        </div>
        {edits.data && <p className="mt-2 text-[12px] text-ink-400">{sum.derived.toLocaleString()} more are worked out by the hub, and nobody changes those.</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-medium text-ink-100">Edit rules</h2>
          {!git && (
            <Button opens="dialog" className="ml-auto" onClick={() => setEditing({ id: null })}>
              <Plus className="mr-1 inline size-3.5" aria-hidden />
              New edit rule
            </Button>
          )}
        </div>
        {git && (
          <p className="text-[12px] text-ink-400">
            The edit rules are declared in git by source <span className="font-mono">{git}</span>, under <span className="font-mono">config.access.edits</span>. Change them there.
          </p>
        )}
        {policy.edits.length ? (
          <ul className="grid gap-3 lg:grid-cols-2">
            {policy.edits.map((r) => (
              <li key={r.id}>
                <Panel className="h-full space-y-2 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[15px] font-medium text-ink-100">{r.title}</h3>
                      {r.description && <p className="text-[12px] text-ink-400">{r.description}</p>}
                    </div>
                    {!git && <Button opens="dialog" onClick={() => setEditing({ id: r.id })}>Edit</Button>}
                  </div>
                  <p className="text-[12px] text-ink-300">Open to {ruleWho(r, policy)}.</p>
                  <Names label="On" list={r.blueprints} />
                  <Names label="Fields" list={r.fields} />
                  {r.relations.length > 0 && <Names label="Relations" list={r.relations} />}
                </Panel>
              </li>
            ))}
          </ul>
        ) : (
          <p className="max-w-3xl text-sm text-ink-400">No edit rules yet, so only an admin and the holders of "Edit entities" change anything. A rule opens a few named fields to the owners of each entity, or to an audience, and nothing else.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium text-ink-100">What one person may change</h2>
        <Picker label="A person" options={people} value={person} placeholder="Type a name or an address" onChange={setPerson} />
        {person && edits.data?.person && <PersonEdits who={edits.data.person} titleOf={titleOf} policy={policy} />}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="text-base font-medium text-ink-100">Every blueprint</h2>
          <label className="ml-auto block">
            <span className="sr-only">Find a blueprint or a field</span>
            <input className={`${input} w-64`} placeholder="Find a blueprint or a field" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
        <div className="overflow-x-auto rounded-lg border border-ink-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[12px] text-ink-400">
                <th scope="col" className="px-3 py-2 font-medium">Blueprint</th>
                {SHOWN.map((a) => (
                  <th key={a} scope="col" className="px-3 py-2 text-right font-medium" title={AUTHORITY[a].note}>
                    {AUTHORITY[a].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((bp) => (
                <Fragment key={bp.id}>
                  <tr className="border-b border-ink-800 last:border-0">
                    <th scope="row" className="px-3 py-1.5 text-left font-normal">
                      <button type="button" aria-expanded={open === bp.id} onClick={() => setOpen(open === bp.id ? null : bp.id)} className="flex items-center gap-1.5 text-ink-100 hover:text-ink-50">
                        {open === bp.id ? <ChevronDown className="size-3.5 text-ink-400" aria-hidden /> : <ChevronRight className="size-3.5 text-ink-400" aria-hidden />}
                        {bp.title}
                        <span className="font-mono text-[12px] text-ink-500">{bp.entities.toLocaleString()}</span>
                      </button>
                    </th>
                    {SHOWN.map((a) => (
                      <td key={a} className={`px-3 py-1.5 text-right tabular-nums ${bp.counts[a] ? 'text-ink-100' : 'text-ink-500'}`}>
                        {bp.counts[a]}
                      </td>
                    ))}
                  </tr>
                  {open === bp.id && (
                    <tr className="border-b border-ink-800 last:border-0">
                      <td colSpan={SHOWN.length + 1} className="bg-ink-900/70 px-3 py-2">
                        <BlueprintNames bp={bp} policy={policy} only={only} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {edits.data && shown.length === 0 && (
                <tr>
                  <td colSpan={SHOWN.length + 1} className="px-3 py-6 text-center text-ink-400">
                    Nothing matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {edits.data && <Standing data={edits.data} titleOf={titleOf} />}
      {editing && <EditRuleDrawer policy={policy} id={editing.id} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Names({ label, list }: { label: string; list: string[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[12px] text-ink-400">
      {label}
      {list.map((m) => (
        <code key={m} className="rounded-sm bg-ink-850 px-1.5 py-0.5 font-mono text-[12px] text-ink-200">
          {m}
        </code>
      ))}
    </div>
  )
}

/** One blueprint's fields and relations, each with the one authority over it and why. */
function BlueprintNames({ bp, policy, only }: { bp: EditBlueprint; policy: AccessPolicy; only: EditAuthority | null }) {
  const names = bp.names.filter((n) => !only || n.authority === only)
  return (
    <ul className="grid gap-x-6 gap-y-1 md:grid-cols-2">
      {names.map((n) => (
        <li key={`${n.kind}:${n.name}`} className="flex min-w-0 items-baseline gap-2 text-[13px]">
          <Badge className="shrink-0 border-ink-600 text-ink-200" title={AUTHORITY[n.authority].note}>
            {AUTHORITY[n.authority].chip}
          </Badge>
          <span className="min-w-0">
            <span className="text-ink-100">{words(n.title)}</span>
            {n.kind === 'relation' && <span className="text-ink-500"> relation</span>}
            <span className="block text-[12px] text-ink-400">
              {n.why}
              {n.rules.length > 0 && `: ${n.rules.map((id) => policy.edits.find((r) => r.id === id)?.title ?? id).join(', ')}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function PersonEdits({ who, titleOf, policy }: { who: NonNullable<EditsResponse['person']>; titleOf: (id: string) => string; policy: AccessPolicy }) {
  if (!who.known) return <p className="text-sm text-ink-400">The hub knows nobody by that address.</p>
  if (who.admin) return <p className="text-sm text-ink-300">An admin: changes every value that is not locked to a source, set in git, or worked out.</p>
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-300">
        {who.holds ? 'Holds "Edit entities": changes every value under Edit holders, on every entity, over what a source says too.' : 'Does not hold "Edit entities".'} {who.opened.length ? 'The edit rules also open:' : 'No edit rule opens anything to them.'}
      </p>
      {who.opened.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700">
          {who.opened.map((r) => (
            <li key={`${r.blueprint}:${r.rule}`} className="px-3 py-2 text-[13px]">
              <span className="text-ink-100">{titleOf(r.blueprint)}</span> <span className="text-ink-400">{reachWords(r)}, by {policy.edits.find((x) => x.id === r.rule)?.title ?? r.rule}</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[...r.fields, ...r.relations].map((n) => (
                  <code key={n} className="rounded-sm bg-ink-850 px-1.5 py-0.5 font-mono text-[12px] text-ink-200">
                    {n}
                  </code>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {who.opened.some((r) => r.how === 'owner') && <p className="text-[12px] text-ink-400">As an owner they write only where no source says a value, or where the field is sticky.</p>}
    </div>
  )
}

/** The hand values standing over what a source says, oldest first. */
function Standing({ data, titleOf }: { data: EditsResponse; titleOf: (id: string) => string }) {
  const [all, setAll] = useState(false)
  const rows = all ? data.overrides : data.overrides.slice(0, 20)
  return (
    <section className="space-y-3">
      <h2 className="text-base font-medium text-ink-100">Standing overrides ({data.overridesTotal.toLocaleString()})</h2>
      <p className="max-w-3xl text-[12px] text-ink-400">A value someone typed over what a source says. It gives way when the source says something else, and stays for as long as the source says the same, so an old one may be wrong. Open the entity to take it off.</p>
      {rows.length ? (
        <div className="overflow-x-auto rounded-lg border border-ink-700">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[12px] text-ink-400">
                <th scope="col" className="px-3 py-2 font-medium">Entity</th>
                <th scope="col" className="px-3 py-2 font-medium">Field</th>
                <th scope="col" className="px-3 py-2 font-medium">Typed</th>
                <th scope="col" className="px-3 py-2 font-medium">The source says</th>
                <th scope="col" className="px-3 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={`${o.blueprint}:${o.key}:${o.field}`} className="border-b border-ink-800 align-top last:border-0">
                  <td className="px-3 py-1.5">
                    <Link to={{ page: 'entity', blueprint: o.blueprint, key: o.key }} className="text-orbit hover:underline">
                      {o.title}
                    </Link>
                    <div className="text-[12px] text-ink-400">{titleOf(o.blueprint)}</div>
                  </td>
                  <td className="px-3 py-1.5 text-ink-200">
                    {words(o.field)}
                    {o.sticky && <div className="text-[12px] text-ink-400">Sticky: it stays when the source moves</div>}
                  </td>
                  <td className="px-3 py-1.5 [overflow-wrap:anywhere] text-ink-100">{said(o.value)}</td>
                  <td className="px-3 py-1.5 [overflow-wrap:anywhere] text-ink-300">
                    {said(o.pushed)}
                    <div className="font-mono text-[12px] text-ink-500">{o.source}</div>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-ink-300">
                    {o.by}
                    <div className="text-[12px] text-ink-400">{ago(o.at)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-ink-400">None. Every value a source says is shown as it says it.</p>
      )}
      {data.overrides.length > 20 && <Button onClick={() => setAll(!all)}>{all ? 'Show the oldest 20' : `Show ${data.overrides.length === data.overridesTotal ? 'all' : 'the oldest'} ${data.overrides.length.toLocaleString()}`}</Button>}
    </section>
  )
}

function said(value: unknown): string {
  return value === null || value === undefined || value === '' ? '(empty)' : typeof value === 'object' ? short(JSON.stringify(value), 60) : short(value, 60)
}

const BLANK: EditRule = { id: '', title: '', blueprints: [], fields: [], relations: [], audiences: [] }

/** One edit rule, new or as saved: what it opens is worked out as it is written, and the hub checks it on save. */
function EditRuleDrawer({ policy, id, onClose }: { policy: AccessPolicy; id: string | null; onClose: () => void }) {
  const was = id ? policy.edits.find((r) => r.id === id) : undefined
  const [rule, setRule] = useState<EditRule>(() => (was ? structuredClone(was) : BLANK))
  const [removing, setRemoving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const change = usePolicyChange()
  const blueprints = useBlueprints().data?.blueprints ?? []
  const person = useAccessSettings().data?.person
  const roles = useMemo(() => [...new Set([...ownsPaths(person?.owns).flatMap((p) => (p.as ? [p.as] : [])), SELF_ROLE])], [person])
  const opens = useMemo(() => ruleOpens(rule, blueprints), [rule, blueprints])
  const taken = !id && policy.edits.some((r) => r.id === rule.id)
  const changed = removing || JSON.stringify(rule) !== JSON.stringify(was ?? BLANK)
  const ready = removing || (POLICY_ID.test(rule.id) && !taken && !!rule.title.trim())
  const set = (part: Partial<EditRule>) => setRule((r) => ({ ...r, ...part }))
  const save = async () => {
    const edits = removing ? policy.edits.filter((r) => r.id !== id) : id ? policy.edits.map((r) => (r.id === id ? rule : r)) : [...policy.edits, rule]
    const result = await change.mutateAsync({ policy: { ...policy, edits }, save: true })
    if (result.saved) onClose()
    else setProblems(result.problems)
  }
  return (
    <Drawer title={id ? rule.title || id : 'New edit rule'} subtitle="Edit rule" icon={<Pencil className="size-4" aria-hidden />} onClose={onClose} unsaved={changed} width={680}>
      <div className="space-y-5 p-4">
        {removing ? (
          <p className="text-sm text-ink-300">Remove the {rule.title} rule. Whoever it let in changes those values no more; what they wrote stays.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <Kicker>Title</Kicker>
                <input className={`${input} mt-1 w-full`} value={rule.title} onChange={(e) => set({ title: e.target.value, ...(id ? {} : { id: slug(e.target.value) }) })} />
              </label>
              <label className="block">
                <Kicker>Id</Kicker>
                <input className={`${input} mt-1 w-full font-mono`} value={rule.id} disabled={!!id} onChange={(e) => set({ id: e.target.value })} />
                {rule.id && !POLICY_ID.test(rule.id) && <span className="text-[12px] text-amber">Lowercase letters, digits, - and _, starting with a letter.</span>}
                {taken && <span className="text-[12px] text-amber">Another edit rule has this id.</span>}
              </label>
            </div>
            <label className="block">
              <Kicker>Description</Kicker>
              <input className={`${input} mt-1 w-full`} value={rule.description ?? ''} placeholder="What people keep up to date with it, and why it is theirs" onChange={(e) => set({ description: e.target.value || undefined })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <List label="Blueprints" hint="One id a line. * stands for any run of characters." value={rule.blueprints} onChange={(blueprints) => set({ blueprints })} placeholder={'sw_service\nit_*'} />
              <List label="Fields" hint="title and icon are fields too." value={rule.fields} onChange={(fields) => set({ fields })} placeholder={'description\nnotes'} />
              <List label="Relations" hint="Leave empty to open none." value={rule.relations} onChange={(relations) => set({ relations })} placeholder="depends_on" />
            </div>
            <fieldset className="space-y-2">
              <legend className="label">Open to</legend>
              {policy.audiences.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm text-ink-200">
                  <input type="checkbox" checked={rule.audiences.includes(a.id)} onChange={(e) => set({ audiences: e.target.checked ? [...rule.audiences, a.id] : rule.audiences.filter((x) => x !== a.id) })} />
                  The {a.title} audience, on every entity, over what a source says too
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-ink-200">
                <input type="checkbox" checked={!!rule.owned} onChange={(e) => setRule(({ owned: _o, ...r }) => (e.target.checked ? { ...r, owned: { through: [], roles: [] } } : r))} />
                The owners of each entity, where no source says the value
              </label>
              {rule.owned && (
                <div className="grid gap-3 pl-6 sm:grid-cols-2">
                  <List label="Roles that count" hint={`Empty counts every role. The model names: ${roles.join(', ')}. ${SELF_ROLE} is a person on their own entity.`} value={rule.owned.roles} onChange={(r) => set({ owned: { ...rule.owned!, roles: r } })} placeholder="owner" />
                  <List label="Also through" hint="A relation of the entity: owning what it points at counts, such as its program." value={rule.owned.through} onChange={(through) => set({ owned: { ...rule.owned!, through } })} placeholder="program" />
                </div>
              )}
            </fieldset>
            <section aria-live="polite" className="space-y-1.5">
              <Kicker>What it opens</Kicker>
              {opens.length === 0 && <p className="text-[13px] text-ink-400">No blueprint matches yet.</p>}
              {opens.slice(0, 30).map((o) => (
                <div key={o.blueprint} className="text-[13px]">
                  <span className="text-ink-100">{o.title}</span>{' '}
                  <span className="text-ink-300">{[...o.fields, ...o.relations].join(', ') || 'nothing'}</span>
                  {o.never.length > 0 && <div className="text-[12px] text-ink-400">Never opened: {o.never.map((n) => `${n.name} (${n.why})`).join(', ')}</div>}
                </div>
              ))}
              {opens.length > 30 && <p className="text-[12px] text-ink-400">And {plural(opens.length - 30, 'more blueprint')}.</p>}
              {rule.owned && <p className="text-[12px] text-ink-400">Once saved, the relations that say who owns these entities are changed by an admin alone, so nobody makes themselves an owner.</p>}
            </section>
          </>
        )}
        <ErrorNote error={change.error} />
        {problems.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-amber" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button kind={removing ? 'danger' : 'solid'} onClick={() => void save()} disabled={!ready || !changed || change.isPending} title={changed ? undefined : 'Nothing has changed yet'}>
            {removing ? 'Remove the rule' : 'Save'}
          </Button>
          {id && (
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
      </div>
    </Drawer>
  )
}

function List({ label, hint, value, onChange, placeholder }: { label: string; hint: string; value: string[]; onChange: (list: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(() => value.join('\n'))
  return (
    <label className="block">
      <Kicker>{label}</Kicker>
      <textarea
        className={`${input} mt-1 h-24 w-full font-mono`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          onChange([...new Set(e.target.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))])
        }}
      />
      <span className="text-[12px] text-ink-400">{hint}</span>
    </label>
  )
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 64)
}
