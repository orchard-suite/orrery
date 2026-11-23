import { useMemo, useState } from 'react'
import { targetId, type PostureItem, type PostureResponse, type PostureReviewRow, type PostureTarget } from '../../shared/posture.ts'
import { useMarkReviewed } from '../api.ts'
import { Badge, Button, Empty, ErrorNote, input, Kicker, Panel } from './ui.tsx'
import { grantWords, plural } from './security-words.ts'

/**
 * Who sees what, at a glance: every blueprint by section down the side, each
 * audience across the top, and the people in none last. A cell counts the
 * audience's people, admins aside, who see the blueprint, and the fields kept
 * from them there. Restricted blueprints lead each section.
 */
export function AccessMap({ data, onTarget }: { data: PostureResponse; onTarget: (t: PostureTarget) => void }) {
  const [q, setQ] = useState('')
  const [restricted, setRestricted] = useState(false)
  const items = useMemo(() => new Map(data.items.map((i) => [targetId(i.target), i])), [data.items])
  const fieldsOf = useMemo(() => {
    const out = new Map<string, PostureItem[]>()
    for (const i of data.items) if (i.target.kind === 'field' && !i.open) out.set(i.target.blueprint, [...(out.get(i.target.blueprint) ?? []), i])
    return out
  }, [data.items])
  const blueprints = data.items.filter((i): i is PostureItem & { target: { kind: 'blueprint'; id: string } } => i.target.kind === 'blueprint')
  const shown = blueprints.filter((b) => (!restricted || !b.open || fieldsOf.has(b.target.id)) && (!q || `${b.title} ${b.target.id} ${b.group ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const groups = new Map<string, typeof shown>()
  for (const b of shown) groups.set(b.group ?? 'No section', [...(groups.get(b.group ?? 'No section') ?? []), b])
  for (const list of groups.values()) list.sort((a, b) => Number(a.open) - Number(b.open) || a.title.localeCompare(b.title))
  const cols = data.map
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-48">
          <Kicker>Search</Kicker>
          <input className={`${input} mt-1 w-full`} value={q} placeholder="A blueprint or a section" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
          Restricted only
        </label>
      </div>
      <p className="text-[12px] text-ink-400">Each cell: how many of the column's people see the blueprint, admins aside, and how many of its fields are kept from them. Admins see everything.</p>
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-ink-800 text-[12px] text-ink-400">
            <tr>
              <th className="px-3 py-2 font-medium">Blueprint</th>
              <th className="px-2 py-2 font-medium">Who sees it</th>
              {cols.map((c) => (
                <th key={c.audience ?? ''} className="px-2 py-2 text-center font-medium">
                  {c.title}
                  <div className="font-normal text-ink-500">{plural(c.people, 'person', 'people')}</div>
                </th>
              ))}
            </tr>
          </thead>
          {[...groups].map(([group, list]) => (
            <tbody key={group} className="divide-y divide-ink-800 border-b border-ink-800">
              <tr>
                <th colSpan={2 + cols.length} scope="rowgroup" className="bg-ink-850 px-3 py-1.5 text-[12px] font-medium text-ink-300">
                  {group}
                </th>
              </tr>
              {list.map((b) => {
                const hidden = fieldsOf.get(b.target.id) ?? []
                return (
                  <tr key={b.target.id} className="align-top">
                    <th scope="row" className="px-3 py-2 font-normal">
                      <button type="button" className="text-left text-ink-100 hover:underline" onClick={() => onTarget(b.target)} title="See who can">
                        {b.title}
                      </button>
                      <div className="font-mono text-[12px] text-ink-500">{b.target.id}</div>
                    </th>
                    <td className="px-2 py-2 text-[12px] text-ink-300">
                      {ruleWords(b, data)}
                      {hidden.length > 0 && <div className="text-ink-400">{restrictedFields(hidden, data)}</div>}
                    </td>
                    {cols.map((c) => {
                      const cell = c.cells[b.target.id]
                      return <Cell key={c.audience ?? ''} sees={cell?.sees ?? 0} of={c.people} hidden={cell?.hidden ?? 0} />
                    })}
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
        {!shown.length && <p className="px-4 py-6 text-sm text-ink-400">Nothing matches.</p>}
      </Panel>
      {items.size === 0 && <Empty>No blueprints yet.</Empty>}
    </div>
  )
}

function Cell({ sees, of, hidden }: { sees: number; of: number; hidden: number }) {
  if (!of) return <td className="px-2 py-2 text-center text-ink-500">·</td>
  const all = sees === of
  const none = sees === 0
  const words = none ? 'None see it' : all ? (of === 1 ? 'Sees it' : 'All see it') : `${sees} of ${of} see it`
  return (
    <td className="px-2 py-2 text-center text-[12px]" title={`${words}${hidden ? `; ${plural(hidden, 'field')} kept from them` : ''}`}>
      <span className={none ? 'text-ink-500' : all ? 'text-ink-100' : 'text-amber'}>
        <span aria-hidden>{none ? '○' : all ? '●' : '◐'}</span> {none ? 'none' : all ? 'all' : `${sees}/${of}`}
      </span>
      {!none && hidden > 0 && <div className="text-ink-400">−{plural(hidden, 'field')}</div>}
    </td>
  )
}

/** Who a rule lets in, in words: its audiences by title, then its grants. */
export function ruleWords(i: PostureItem, data: PostureResponse): string {
  if (i.open) return i.target.kind === 'field' ? 'Everyone who sees the blueprint' : i.target.kind === 'action' ? 'Everyone signed in' : 'Everyone'
  const parts = [...i.audiences.map((id) => data.policy.policy.audiences.find((a) => a.id === id)?.title ?? id), ...i.grants.map(grantWords)]
  return parts.length ? parts.join('; ') : 'Admins only'
}

/** The fields a blueprint keeps from some, by class or by who sees them. */
function restrictedFields(fields: PostureItem[], data: PostureResponse): string {
  const by = new Map<string, number>()
  for (const f of fields) {
    const key = f.class ? `${data.classes.find((c) => c.id === f.class)?.title ?? f.class} class` : ruleWords(f, data)
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  return [...by].map(([k, n]) => `${plural(n, 'field')}: ${k}`).join('; ')
}

/**
 * The review queue: every blueprint, the ones never reviewed or holding
 * fields the last review did not see first, newest first. Mark what you have
 * looked at reviewed, or change who sees it from here.
 */
export function Review({ data, onTarget, onChange }: { data: PostureResponse; onTarget: (t: PostureTarget) => void; onChange: (items: PostureItem[]) => void }) {
  const [waiting, setWaiting] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const mark = useMarkReviewed()
  const items = useMemo(() => new Map(data.items.map((i) => [targetId(i.target), i])), [data.items])
  const isWaiting = (r: PostureReviewRow) => !r.reviewedAt || r.newFields.length > 0
  const rows = data.review.filter((r) => !waiting || isWaiting(r))
  const count = data.review.filter(isWaiting).length
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const all = rows.length > 0 && rows.every((r) => picked.has(r.blueprint))
  const chosen = [...picked]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-ink-300">
          {count ? `${plural(count, 'blueprint')} ${count === 1 ? 'waits' : 'wait'} for a look: never reviewed, or holding fields that came after the last review.` : 'Every blueprint has been reviewed as it stands.'} A field in a class is covered wherever it lands; the rest are open until someone decides.
        </p>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={waiting} onChange={(e) => setWaiting(e.target.checked)} />
          Waiting only
        </label>
      </div>
      {chosen.length > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-200 shadow-lg shadow-ink-950/40">
          <span>{chosen.length} picked</span>
          <Button kind="solid" disabled={mark.isPending} onClick={() => mark.mutate(chosen, { onSuccess: () => setPicked(new Set()) })}>
            Mark reviewed
          </Button>
          <Button opens="dialog" onClick={() => onChange(chosen.map((id) => items.get(`blueprint:${id}`)).filter((i): i is PostureItem => !!i))}>
            Change who sees them
          </Button>
          <Button onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      )}
      <ErrorNote error={mark.error} />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-ink-800 text-[12px] text-ink-400">
            <tr>
              <th className="w-8 px-3 py-2">
                <input type="checkbox" aria-label="Pick every row shown" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.blueprint)))} />
              </th>
              <th className="px-2 py-2 font-medium">Blueprint</th>
              <th className="px-2 py-2 font-medium">Came</th>
              <th className="px-2 py-2 font-medium">Reviewed</th>
              <th className="px-2 py-2 font-medium">Who sees it</th>
              <th className="px-2 py-2 font-medium">New fields</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {rows.map((r) => {
              const bp = items.get(`blueprint:${r.blueprint}`)
              return (
                <tr key={r.blueprint} className="align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Pick ${r.title}`} checked={picked.has(r.blueprint)} onChange={() => toggle(r.blueprint)} />
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" className="text-left text-ink-100 hover:underline" onClick={() => onTarget({ kind: 'blueprint', id: r.blueprint })}>
                      {r.title}
                    </button>
                    <div className="font-mono text-[12px] text-ink-500">
                      {r.blueprint}
                      {r.group ? ` · ${r.group}` : ''}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-ink-300">{day(r.createdAt)}</td>
                  <td className="px-2 py-2 text-ink-300">{r.reviewedAt ? <>{day(r.reviewedAt)}<div className="text-[12px] text-ink-500">{r.reviewedBy}</div></> : <span className="text-amber">Never</span>}</td>
                  <td className="px-2 py-2 text-[12px] text-ink-300">{bp ? ruleWords(bp, data) : ''}</td>
                  <td className="px-2 py-2">
                    <NewFields row={r} data={data} items={items} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-6 text-sm text-ink-400">Nothing waits.</p>}
      </Panel>
    </div>
  )
}

/** The fields a review has not seen, the ones a class or a rule covers marked, at most a dozen and a count of the rest. */
function NewFields({ row, data, items }: { row: PostureReviewRow; data: PostureResponse; items: Map<string, PostureItem> }) {
  const [all, setAll] = useState(false)
  if (!row.newFields.length) return <span className="text-[12px] text-ink-500">None</span>
  const list = all ? row.newFields : row.newFields.slice(0, 12)
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((f) => {
        const i = items.get(`field:${row.blueprint}.${f}`)
        const cls = i?.class ? data.classes.find((c) => c.id === i.class)?.title : null
        return (
          <Badge key={f} className={cls ? 'border-green/50' : i && !i.open ? 'border-ink-500' : ''} title={cls ? `In the ${cls} class` : i && !i.open ? ruleWords(i, data) : 'Open'}>
            <span className="font-mono text-[12px]">{f}</span>
            {cls && <span className="ml-1 text-ink-400">· {cls}</span>}
          </Badge>
        )
      })}
      {row.newFields.length > list.length && (
        <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setAll(true)}>
          +{row.newFields.length - list.length} more
        </button>
      )}
    </div>
  )
}

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}
