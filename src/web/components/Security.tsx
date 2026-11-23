import { ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AccessRule } from '../../shared/model.ts'
import { targetId, type PostureChange, type PostureFinding, type PostureHandmade, type PostureItem, type PosturePreview, type PostureResponse, type PostureSeverity, type PostureTarget } from '../../shared/posture.ts'
import { useBlueprintName, useEditEntity, useIsAdmin, usePosture, usePostureChange, usePostureReach, useViewingAs } from '../api.ts'
import { ago } from '../format.ts'
import { AccessEditor } from './AccessEditor.tsx'
import { useChanged } from '../layers.ts'
import { Drawer } from './Drawer.tsx'
import { Picker } from './Picker.tsx'
import { NO_FILTER, type ActionFilter } from './security-actions.ts'
import { SecurityActions } from './SecurityActions.tsx'
import { AccessMap, Review, ruleWords } from './SecurityMap.tsx'
import { Overview, PolicyDrawer, type PolicyEdit } from './SecurityPolicy.tsx'
import { WhoEdits } from './SecurityEdits.tsx'
import { reachWords } from './security-edits.ts'
import { Who } from './SecurityWho.tsx'
import { Badge, Button, Empty, ErrorNote, input, Kicker, Lamp, Link, Panel, TabPanel, Tabs } from './ui.tsx'
import { useVisit } from '../trail.ts'

type Tab = 'overview' | 'map' | 'review' | 'handmade' | 'findings' | 'actions' | 'edits' | 'who' | 'rules'

const SEVERITY: Record<PostureSeverity, { lamp: 'red' | 'amber' | 'grey'; word: string }> = {
  high: { lamp: 'red', word: 'High' },
  medium: { lamp: 'amber', word: 'Medium' },
  low: { lamp: 'grey', word: 'Low' },
}

/**
 * The security posture: the audiences and field classes the rules are built
 * from, a map of who sees what, the blueprints and fields waiting for review,
 * the findings worth a look, every action with who may run it and when it
 * last ran, who can see or run any one thing, and every rule as a row to
 * change many at once with a preview of who gains and who loses.
 * An admin's alone, and nothing here changes anything while viewing as
 * someone else.
 */
export function Security() {
  const admin = useIsAdmin()
  const viewing = useViewingAs()
  const posture = usePosture(admin && !viewing)
  const [tab, setTab] = useVisit<Tab>('security.tab', 'overview')
  const [target, setTarget] = useVisit<string | null>('security.target', null)
  const [editing, setEditing] = useState<PolicyEdit | null>(null)
  const [changing, setChanging] = useState<PostureItem[] | null>(null)
  // Kept here, so the filters and the open row are still there after a look at another tab.
  const [actionFilter, setActionFilter] = useVisit<ActionFilter>('security.actionFilter', NO_FILTER)
  const [actionOpen, setActionOpen] = useState<string | null>(null)
  if (viewing) return <Empty>Security is where access rules are audited and changed, and nothing is changed while viewing as someone else. Exit to open it.</Empty>
  if (!admin) return <Empty>The security posture is an admin's alone.</Empty>
  const data = posture.data
  const open = (t: PostureTarget) => {
    setTarget(targetId(t))
    setTab('who')
  }
  const waiting = data ? data.review.filter((r) => !r.reviewedAt || r.newFields.length > 0).length : 0
  return (
    <div className="space-y-5 py-6">
      <div>
        <h1 className="page-title">Security</h1>
        <p className="max-w-3xl text-sm text-ink-400">Who sees, changes, and runs what in this hub. Name your audiences and the classes of data you hold close once, and let every rule point at them. Everything here is worked out for every person and token the hub knows, with the same rules every page uses, and every change is recorded in the activity log.</p>
      </div>
      <ErrorNote error={posture.error} />
      {data && posture.isFetching && (
        <p className="text-sm text-ink-400" aria-live="polite">
          Updating with the latest change…
        </p>
      )}
      {data && <Summary data={data} waiting={waiting} />}
      <div className="border-b border-ink-800">
        <Tabs
          id="security"
          label="Security views"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'map', label: 'Map' },
            { id: 'review', label: `Review${data ? ` (${waiting})` : ''}` },
            { id: 'handmade', label: `Set by hand${data ? ` (${data.handmade.length})` : ''}` },
            { id: 'findings', label: `Findings${data ? ` (${data.findings.length})` : ''}` },
            { id: 'actions', label: 'Actions' },
            { id: 'edits', label: 'Who edits' },
            { id: 'who', label: 'Who can' },
            { id: 'rules', label: 'Every rule' },
          ]}
        />
      </div>
      <TabPanel id="security" value={tab}>
        {!data ? (
          posture.isLoading && <p className="text-sm text-ink-400">Working out who reaches what…</p>
        ) : tab === 'overview' ? (
          <Overview data={data} onEdit={setEditing} onTarget={open} />
        ) : tab === 'map' ? (
          <AccessMap data={data} onTarget={open} />
        ) : tab === 'review' ? (
          <Review data={data} onTarget={open} onChange={setChanging} />
        ) : tab === 'handmade' ? (
          <Handmade rows={data.handmade} onCleared={() => void posture.refetch()} />
        ) : tab === 'findings' ? (
          <Findings findings={data.findings} items={data.items} onTarget={open} onChange={setChanging} />
        ) : tab === 'actions' ? (
          <SecurityActions data={data} filter={actionFilter} onFilter={setActionFilter} open={actionOpen} onOpen={setActionOpen} />
        ) : tab === 'edits' ? (
          <WhoEdits data={data} />
        ) : tab === 'who' ? (
          <WhoCan target={target} setTarget={setTarget} data={data} />
        ) : (
          <RuleMap data={data} onTarget={open} onChange={setChanging} onClass={(include) => setEditing({ kind: 'class', id: null, seed: { include } })} />
        )}
      </TabPanel>
      {data && editing && <PolicyDrawer data={data} edit={editing} onClose={() => setEditing(null)} />}
      {changing && <ChangeDrawer items={changing} onClose={() => setChanging(null)} onSaved={() => {}} />}
    </div>
  )
}

/**
 * The values people set by hand on what access is decided from. Each was
 * set before the guard, or by someone who may: leave one to keep it, or
 * clear it to give the field or relation back to its sources.
 */
function Handmade({ rows, onCleared }: { rows: PostureHandmade[]; onCleared: () => void }) {
  const edit = useEditEntity()
  const named = useBlueprintName()
  if (!rows.length) return <Empty>Nothing that access is decided from was set by hand.</Empty>
  const clear = (r: PostureHandmade) => edit.mutate({ ref: r.entity, patch: r.kind === 'field' ? { fields: { [r.name]: null } } : { relations: { [r.name]: null } } }, { onSuccess: onCleared })
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-ink-300">Access is decided from these, and a person set each one by hand. Leave one to keep it. Clear it to give it back to what sources and rules say.</p>
      <ErrorNote error={edit.error} />
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800 text-left text-[12px] text-ink-400">
              <th className="px-4 py-2 font-medium">On</th>
              <th className="px-2 py-2 font-medium">What</th>
              <th className="px-2 py-2 font-medium">Set by</th>
              <th className="px-2 py-2 font-medium">When</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.entity.blueprint}:${r.entity.key}:${r.kind}:${r.name}`} className="border-b border-ink-800 last:border-0">
                <td className="px-4 py-2">
                  <Link to={{ page: 'entity', ...r.entity }} className="text-ink-100 hover:underline">
                    {r.title}
                  </Link>
                  <span className="ml-2 text-[12px] text-ink-400">{named(r.entity.blueprint)}</span>
                </td>
                <td className="px-2 py-2">
                  <span className="font-mono text-[12px] text-ink-200">{r.name}</span>
                  <span className="ml-2 text-[12px] text-ink-400">{r.kind === 'relation' ? 'relation' : 'field'}{r.over ? ', over what a source sent' : ''}</span>
                </td>
                <td className="px-2 py-2 font-mono text-[12px] text-ink-300">{r.by ?? 'unknown'}</td>
                <td className="px-2 py-2 text-[12px] text-ink-300 tabular-nums">{ago(r.at)}</td>
                <td className="px-4 py-2 text-right">
                  <Button onClick={() => clear(r)} disabled={edit.isPending}>
                    Clear
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

function Summary({ data, waiting }: { data: PostureResponse; waiting: number }) {
  const count = (s: PostureSeverity) => data.findings.filter((f) => f.severity === s).length
  const people = data.principals.filter((p) => p.kind === 'person').length
  const tokens = data.principals.length - people
  const fields = Object.values(data.coverage).reduce((a, b) => a + b, 0)
  const tiles: { label: string; value: number; note: string }[] = [
    { label: 'Fields nobody decided', value: data.coverage.unreviewed, note: `of ${fields}; ${data.coverage.classified} in a class` },
    { label: 'Waiting for review', value: waiting, note: `of ${data.review.length} blueprints` },
    { label: 'High findings', value: count('high'), note: `${count('medium')} medium, ${count('low')} low` },
    { label: 'Audiences', value: data.audiences.length, note: `${data.classes.length} ${data.classes.length === 1 ? 'class' : 'classes'}` },
    { label: 'People judged', value: people, note: `${tokens} machine ${tokens === 1 ? 'token' : 'tokens'}` },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <Panel key={t.label} className="px-4 py-3">
          <Kicker>{t.label}</Kicker>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-100">{t.value}</div>
          <div className="text-[12px] text-ink-400">{t.note}</div>
        </Panel>
      ))}
    </div>
  )
}

function Severity({ s }: { s: PostureSeverity }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-ink-200">
      <Lamp level={SEVERITY[s].lamp} size="sm" />
      {SEVERITY[s].word}
    </span>
  )
}

/** The findings, one panel a kind: a kind with many findings is read as one, its findings folded inside it. */
function Findings({ findings, items, onTarget, onChange }: { findings: PostureFinding[]; items: PostureItem[]; onTarget: (t: PostureTarget) => void; onChange: (items: PostureItem[]) => void }) {
  if (!findings.length) return <Empty>Nothing in the access rules needs a look.</Empty>
  const byId = new Map(items.map((i) => [targetId(i.target), i]))
  const itemsOf = (list: PostureFinding[]) => [...new Map(list.flatMap((f) => f.targets).map((t) => [targetId(t), t])).values()].map((t) => byId.get(targetId(t))).filter((i): i is PostureItem => !!i)
  const families = new Map<string, PostureFinding[]>()
  for (const f of findings) families.set(f.family, [...(families.get(f.family) ?? []), f])
  return (
    <ul className="space-y-3">
      {[...families].map(([family, list]) => {
        const worst = list.reduce<PostureSeverity>((w, f) => (ORDER[f.severity] < ORDER[w] ? f.severity : w), 'low')
        const reach = itemsOf(list)
        if (list.length === 1) return <li key={family}><FindingPanel f={list[0]!} reach={reach} onTarget={onTarget} onChange={onChange} /></li>
        return (
          <li key={family}>
            <Panel className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <Severity s={worst} />
                <h2 className="min-w-0 flex-1 text-[15px] font-medium text-ink-100">
                  {family} <span className="text-ink-400">({list.length})</span>
                </h2>
                {reach.length > 0 && (
                  <Button kind="solid" opens="dialog" onClick={() => onChange(reach)}>
                    Change all {reach.length}
                  </Button>
                )}
              </div>
              <p className="max-w-3xl text-sm text-ink-300">{list[0]!.detail}</p>
              <details>
                <summary className="cursor-pointer text-[12px] text-ink-400">Each of the {list.length}</summary>
                <ul className="mt-2 divide-y divide-ink-800 rounded-md border border-ink-800">
                  {list.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 text-ink-200">{f.title}</span>
                      {f.targets.slice(0, 1).map((t) => (
                        <Button key={targetId(t)} onClick={() => onTarget(t)} title="See who can">
                          Who can
                        </Button>
                      ))}
                    </li>
                  ))}
                </ul>
              </details>
            </Panel>
          </li>
        )
      })}
    </ul>
  )
}

const ORDER: Record<PostureSeverity, number> = { high: 0, medium: 1, low: 2 }

function FindingPanel({ f, reach, onTarget, onChange }: { f: PostureFinding; reach: PostureItem[]; onTarget: (t: PostureTarget) => void; onChange: (items: PostureItem[]) => void }) {
  return (
    <Panel className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Severity s={f.severity} />
        <h2 className="min-w-0 flex-1 text-[15px] font-medium text-ink-100">{f.title}</h2>
      </div>
      <p className="max-w-3xl text-sm text-ink-300">{f.detail}</p>
      {(f.targets.length > 0 || f.who.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {f.targets.slice(0, 20).map((t) => (
            <Button key={targetId(t)} onClick={() => onTarget(t)} title="See who can">
              {targetLabel(t)}
            </Button>
          ))}
          {f.targets.length > 20 && <span className="text-ink-400">and {f.targets.length - 20} more</span>}
          {f.who.map((w) => (
            <Badge key={w}>{w}</Badge>
          ))}
          {reach.length > 0 && (
            <Button kind="solid" opens="dialog" className="ml-auto" onClick={() => onChange(reach)}>
              Change {reach.length === 1 ? 'it' : `these ${reach.length}`}
            </Button>
          )}
        </div>
      )}
    </Panel>
  )
}

/** Every rule as a row, filterable, with rows to pick for one change. */
function RuleMap({ data, onTarget, onChange, onClass }: { data: PostureResponse; onTarget: (t: PostureTarget) => void; onChange: (items: PostureItem[]) => void; onClass: (fields: string[]) => void }) {
  const items = data.items
  const [kind, setKind] = useVisit<'all' | PostureTarget['kind']>('security.kind', 'all')
  const [group, setGroup] = useVisit('security.group', '')
  const [q, setQ] = useVisit('security.q', '')
  const [sensitive, setSensitive] = useVisit('security.sensitive', false)
  const [who, setWho] = useState<'any' | 'open' | 'restricted'>('any')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const groups = useMemo(() => [...new Set(items.map((i) => i.group).filter((g): g is string => !!g))].sort(), [items])
  const shown = items.filter((i) => (kind === 'all' || i.target.kind === kind) && (!group || i.group === group) && (!sensitive || i.sensitive.length > 0 || !i.open) && (who === 'any' || (who === 'open') === i.open) && (!q || `${i.title} ${targetId(i.target)}`.toLowerCase().includes(q.toLowerCase())))
  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const all = shown.length > 0 && shown.every((i) => picked.has(targetId(i.target)))
  const chosen = items.filter((i) => picked.has(targetId(i.target)))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-48">
          <Kicker>Search</Kicker>
          <input className={`${input} mt-1 w-full`} value={q} placeholder="A blueprint, field, or action" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="block">
          <Kicker>Kind</Kicker>
          <select className={`${input} mt-1`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Everything</option>
            <option value="blueprint">Blueprints</option>
            <option value="field">Fields</option>
            <option value="action">Actions</option>
          </select>
        </label>
        <label className="block">
          <Kicker>Who</Kicker>
          <select className={`${input} mt-1`} value={who} onChange={(e) => setWho(e.target.value as typeof who)}>
            <option value="any">Anyone</option>
            <option value="open">Open to everyone</option>
            <option value="restricted">Some people only</option>
          </select>
        </label>
        <label className="block">
          <Kicker>Section</Kicker>
          <select className={`${input} mt-1`} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Every section</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          Sensitive or restricted only
        </label>
      </div>
      {chosen.length > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 shadow-lg shadow-ink-950/40">
          <span>{chosen.length} picked</span>
          <Button kind="solid" opens="dialog" onClick={() => onChange(chosen)}>
            Change access
          </Button>
          {!data.policy.source && chosen.every((i) => i.target.kind === 'field') && (
            <Button opens="dialog" disabled={!data.audiences.length} title={data.audiences.length ? 'Gather these fields into a class, so one rule decides who sees all of them' : 'A class names an audience: make one first'} onClick={() => onClass(chosen.map((i) => (i.target.kind === 'field' ? `${i.target.blueprint}.${i.target.field}` : '')))}>
              Make a class of these
            </Button>
          )}
          <Button onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      )}
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-ink-800 text-[12px] text-ink-400">
            <tr>
              <th className="w-8 px-3 py-2">
                <input type="checkbox" aria-label="Pick every row shown" checked={all} onChange={() => setPicked((p) => (all ? new Set([...p].filter((id) => !shown.some((i) => targetId(i.target) === id))) : new Set([...p, ...shown.map((i) => targetId(i.target))])))} />
              </th>
              <th className="px-2 py-2 font-medium">Rule on</th>
              <th className="px-2 py-2 font-medium">Who</th>
              <th className="px-2 py-2 text-right font-medium">People</th>
              <th className="px-2 py-2 font-medium">Changed by</th>
              <th className="px-2 py-2 font-medium">Worth knowing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {shown.map((i) => {
              const id = targetId(i.target)
              return (
                <tr key={id} className="align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Pick ${i.title}`} checked={picked.has(id)} onChange={() => toggle(id)} />
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" className="text-left text-ink-100 hover:underline" onClick={() => onTarget(i.target)} title="See who can">
                      {i.title}
                    </button>
                    <div className="font-mono text-[12px] text-ink-500">{id}</div>
                  </td>
                  <td className="px-2 py-2 text-ink-300">{i.class ? `${data.classes.find((c) => c.id === i.class)?.title ?? i.class} class: ${ruleWords(i, data)}` : ruleWords(i, data)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-200">{i.people}</td>
                  <td className="px-2 py-2 text-ink-300">{changedBy(i)}<div className="text-[12px] text-ink-500">{i.origin}</div></td>
                  <td className="px-2 py-2 text-[12px] text-ink-400">{i.sensitive.join('; ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!shown.length && <p className="px-4 py-6 text-sm text-ink-400">Nothing matches.</p>}
      </Panel>
    </div>
  )
}

/** One change to every picked row: preview who gains and loses, then save. */
function ChangeDrawer({ items, onClose, onSaved }: { items: PostureItem[]; onClose: () => void; onSaved: () => void }) {
  const [op, setOp] = useState<'leave' | 'set' | 'add' | 'remove' | 'clear'>('leave')
  const [rule, setRule] = useState<AccessRule | undefined>(undefined)
  const [everyone, setEveryone] = useState<'leave' | 'yes' | 'no'>('leave')
  const [mark, setMark] = useState<'leave' | 'lock' | 'unlock'>('leave')
  const changed = useChanged([op, rule, everyone, mark])
  const [preview, setPreview] = useState<PosturePreview | null>(null)
  const change = usePostureChange()
  const actionsOnly = items.every((i) => i.target.kind === 'action')
  const anyActions = items.some((i) => i.target.kind === 'action')
  const spec = (): PostureChange | null => {
    const access = op === 'leave' && everyone === 'leave' ? undefined : { op: op === 'leave' ? ('add' as const) : op, grants: rule?.grants ?? [], audiences: rule?.audiences ?? [], ...(everyone !== 'leave' ? { everyone: everyone === 'yes' } : {}) }
    const adminEdit = mark === 'leave' ? undefined : mark === 'lock'
    if (!access && adminEdit === undefined) return null
    return { targets: items.map((i) => i.target), ...(access ? { access } : {}), ...(adminEdit !== undefined ? { adminEdit } : {}) }
  }
  const run = async (save: boolean) => {
    const c = spec()
    if (!c) return
    const result = await change.mutateAsync({ change: c, save })
    setPreview(result)
    if (result.saved) onSaved()
  }
  const reset = () => setPreview(null)
  return (
    <Drawer title="Change access" subtitle={`${items.length} picked`} icon={<ShieldAlert className="size-4" aria-hidden />} onClose={onClose} unsaved={changed} width={640}>
      <div className="space-y-5 p-4">
        <ul className="flex flex-wrap gap-1.5">
          {items.map((i) => (
            <li key={targetId(i.target)}>
              <Badge>{i.title}</Badge>
            </li>
          ))}
        </ul>
        <fieldset className="space-y-2">
          <legend className="mb-1">
            <Kicker>Who may {actionsOnly ? 'run them' : anyActions ? 'see or run them' : 'see them'}</Kicker>
          </legend>
          {(
            [
              ['leave', 'Leave as it is'],
              ['set', 'Replace who may with these'],
              ['add', 'Add these audiences and grants'],
              ['remove', 'Remove these audiences and values'],
              ['clear', actionsOnly ? 'Admins only (an action with no grants)' : anyActions ? 'Clear: blueprints and fields open to everyone, actions back to admins only' : 'Open to everyone signed in'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-ink-200">
              <input type="radio" name="op" checked={op === value} onChange={() => (setOp(value), reset())} />
              {label}
            </label>
          ))}
          {(op === 'set' || op === 'add' || op === 'remove') && (
            <div className="rounded-md border border-ink-800 p-3">
              <AccessEditor value={rule} onChange={(r) => (setRule(r), reset())} what="them" />
            </div>
          )}
        </fieldset>
        {anyActions && (
          <fieldset className="space-y-2">
            <legend className="mb-1">
              <Kicker>Open actions to everyone signed in</Kicker>
            </legend>
            {(
              [
                ['leave', 'Leave as it is'],
                ['yes', 'Yes'],
                ['no', 'No'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-ink-200">
                <input type="radio" name="everyone" checked={everyone === value} onChange={() => (setEveryone(value), reset())} />
                {label}
              </label>
            ))}
          </fieldset>
        )}
        {!actionsOnly && (
          <fieldset className="space-y-2">
            <legend className="mb-1">
              <Kicker>Only an admin changes blueprints and fields</Kicker>
            </legend>
            {(
              [
                ['leave', 'Leave as it is'],
                ['lock', 'Lock: only an admin changes them'],
                ['unlock', 'Unlock: anyone who may edit changes them'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-ink-200">
                <input type="radio" name="mark" checked={mark === value} onChange={() => (setMark(value), reset())} />
                {label}
              </label>
            ))}
          </fieldset>
        )}
        <ErrorNote error={change.error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void run(false)} disabled={!spec() || change.isPending}>
            Preview
          </Button>
          <Button kind="solid" onClick={() => void run(true)} disabled={!preview || preview.saved || change.isPending || !preview.items.some((i) => i.changed && !i.refused)} title={preview ? undefined : 'Preview first, to see who gains and loses'}>
            Save
          </Button>
        </div>
        {preview && <PreviewList preview={preview} />}
      </div>
    </Drawer>
  )
}

function PreviewList({ preview }: { preview: PosturePreview }) {
  const names = (list: string[]) => (list.length ? list.join(', ') : 'nobody')
  return (
    <div className="space-y-3" aria-live="polite">
      <Kicker>{preview.saved ? 'Saved' : 'If you save'}</Kicker>
      {(preview.adminOnly.added.length > 0 || preview.adminOnly.removed.length > 0) && (
        <p className="text-sm text-ink-300">
          {preview.adminOnly.added.length > 0 && <>Becomes an admin's alone to change, because a grant reads through it: {preview.adminOnly.added.join(', ')}. </>}
          {preview.adminOnly.removed.length > 0 && <>No longer an admin's alone: {preview.adminOnly.removed.join(', ')}.</>}
        </p>
      )}
      <ul className="divide-y divide-ink-800 rounded-md border border-ink-800">
        {preview.items.map((i) => (
          <li key={targetId(i.target)} className="space-y-1 px-3 py-2 text-sm">
            <div className="font-medium text-ink-100">{i.title}</div>
            {i.refused ? (
              <div className="text-amber">Left as it is: {i.refused}</div>
            ) : !i.changed ? (
              <div className="text-ink-400">Nothing changes.</div>
            ) : (
              <>
                <div className="text-ink-300">
                  <span className="text-green">Gains:</span> {names(i.gains)}
                </div>
                <div className="text-ink-300">
                  <span className="text-red">Loses:</span> {names(i.loses)}
                </div>
                {(i.gainsChange.length > 0 || i.losesChange.length > 0) && (
                  <div className="text-ink-400">
                    May change it now: {names(i.gainsChange)}. May no longer change it: {names(i.losesChange)}.
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-500">A field that is worked out from others also follows the fields it reads.</p>
    </div>
  )
}

/** Pick a person or token for what they reach, or a blueprint, field, or action for everyone it lets in. Both are searched, not scrolled. */
function WhoCan({ target, setTarget, data }: { target: string | null; setTarget: (t: string | null) => void; data: PostureResponse }) {
  const [person, setPerson] = useState<{ kind: 'person' | 'token'; name: string } | null>(null)
  const people = useMemo(
    () => data.principals.map((p) => ({ id: `${p.kind}:${p.name}`, label: p.name, note: [p.kind === 'token' ? 'machine token' : p.signedIn ? 'signed in' : 'not signed in yet', p.admin ? 'admin' : null].filter(Boolean).join(' · '), group: p.admin ? 'Admins' : p.kind === 'token' ? 'Tokens' : 'People' })),
    [data.principals],
  )
  const targets = useMemo(() => {
    // Restricted first, so what is already held close is what the search finds first.
    const rank = (i: PostureItem) => (i.open ? 1 : 0)
    return [...data.items]
      .sort((a, b) => rank(a) - rank(b) || (a.group ?? '').localeCompare(b.group ?? '') || a.title.localeCompare(b.title))
      .map((i) => ({ id: targetId(i.target), label: i.title, note: `${targetId(i.target)} · ${ruleWords(i, data)}`, group: `${i.open ? 'Open' : 'Restricted'} ${i.target.kind === 'field' ? 'fields' : i.target.kind === 'action' ? 'actions' : 'blueprints'}` }))
  }, [data])
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Picker
          label="A person or token"
          options={people}
          value={person ? `${person.kind}:${person.name}` : null}
          placeholder="Type a name or an address"
          onChange={(id) => {
            const [kind, ...name] = (id ?? '').split(':')
            setPerson(id ? { kind: kind as 'person' | 'token', name: name.join(':') } : null)
            setTarget(null)
          }}
        />
        <span className="pb-2 text-sm text-ink-500">or</span>
        <Picker
          label="A blueprint, field, or action"
          options={targets}
          value={target}
          placeholder="Type a name, such as cost or firewall"
          onChange={(id) => {
            setTarget(id)
            setPerson(null)
          }}
        />
      </div>
      {person ? <Reach who={person} /> : target ? <Who target={target} /> : <Empty>Pick a person or token to see what they reach, or a blueprint, field, or action to see everyone it lets in.</Empty>}
    </div>
  )
}

function Reach({ who }: { who: { kind: 'person' | 'token'; name: string } }) {
  const reach = usePostureReach(who)
  if (reach.error) return <ErrorNote error={reach.error} />
  const r = reach.data
  if (!r) return <p className="text-sm text-ink-400">Working it out…</p>
  const runs = r.actions.filter((a) => a.runs)
  const changes = r.blueprints.filter((b) => b.changes)
  const opened = r.blueprints.filter((b) => !b.changes && b.opened?.length)
  const unseen = r.blueprints.filter((b) => !b.sees)
  const partial = r.blueprints.filter((b) => b.sees && b.hidden.length)
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-300">
        {r.principal.admin ? 'An admin: sees, changes, and runs everything.' : r.principal.kind === 'token' ? 'A machine token reads everything; what it changes and runs follows its role and grants.' : `Holds ${r.principal.permissions.length ? r.principal.permissions.join(', ') : 'no permissions beyond reading'}.`}
        {r.principal.kind === 'person' && !r.principal.signedIn && ' Has not signed in yet.'}
      </p>
      <Section title={`Runs ${runs.length} of ${r.actions.length} actions`}>
        {runs.map((a) => (
          <Line key={a.id} name={a.title} note={`${a.via ?? ''}${a.offered ? '' : '; not offered: something it works on is hidden from them'}`} />
        ))}
      </Section>
      <Section title={`Changes ${changes.length} of ${r.blueprints.length} blueprints`}>
        {changes.map((b) => (
          <Line key={b.id} name={b.title} note={b.locked.length ? `except ${b.locked.join(', ')}, which only an admin changes` : ''} />
        ))}
      </Section>
      {opened.length > 0 && (
        <Section title={`Changes named values of ${opened.length} more by an edit rule`}>
          {opened.map((b) => (
            <Line key={b.id} name={b.title} note={b.opened!.map((o) => `${[...o.fields, ...o.relations].join(', ')} ${reachWords(o)}`).join('; ')} />
          ))}
        </Section>
      )}
      <Section title={`Cannot see ${unseen.length} ${unseen.length === 1 ? 'blueprint' : 'blueprints'}`}>
        {unseen.map((b) => (
          <Line key={b.id} name={b.title} note="" />
        ))}
      </Section>
      <Section title={`Sees ${partial.length} ${partial.length === 1 ? 'blueprint' : 'blueprints'} without some fields`}>
        {partial.map((b) => (
          <Line key={b.id} name={b.title} note={`hidden: ${b.hidden.join(', ')}`} />
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode[] }) {
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>{title}</Kicker>
      </div>
      {children.length ? <ul className="divide-y divide-ink-800">{children}</ul> : <p className="px-4 py-3 text-sm text-ink-500">None.</p>}
    </Panel>
  )
}

function Line({ name, note }: { name: string; note: string }) {
  return (
    <li className="flex flex-wrap gap-x-3 px-4 py-2 text-sm">
      <span className="text-ink-100">{name}</span>
      {note && <span className="text-ink-400">{note}</span>}
    </li>
  )
}

/** Who changes the values a rule guards: an action's definition, or a blueprint's or field's entities. */
function changedBy(i: PostureItem): string {
  if (i.origin === 'hub') return 'The hub'
  if (i.origin.startsWith('git ')) return i.target.kind === 'action' ? 'Git' : i.adminEdit || i.adminOnly ? 'Admins only' : 'Editors'
  if (i.target.kind === 'action') return 'Action managers'
  return i.adminEdit || i.adminOnly ? 'Admins only' : 'Editors'
}

function targetLabel(t: PostureTarget): string {
  return t.kind === 'field' ? `Field ${t.blueprint}.${t.field}` : t.kind === 'action' ? `Action ${t.id}` : `Blueprint ${t.id}`
}
