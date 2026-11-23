import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { parseEntityId } from '../../shared/model.ts'
import type { PostureResponse } from '../../shared/posture.ts'
import { usePostureReach } from '../api.ts'
import { ago } from '../format.ts'
import { Icon } from '../icons.tsx'
import { Picker } from './Picker.tsx'
import { actionRows, audiencesOf, backendsOf, filtering, NO_FILTER, shownActions, teamsOf, type ActionFilter, type ActionRow } from './security-actions.ts'
import { plural } from './security-words.ts'
import { Who } from './SecurityWho.tsx'
import { Badge, Button, Empty, ErrorNote, input, Kicker, Link, Panel } from './ui.tsx'

const COLUMNS = 8

/**
 * Every action as a row: where it belongs, who may run it, how many people
 * that is, whether a run waits for approval, what does the work, and when it
 * last ran. The filters hold together, and a row opens to the people it lets
 * in, each with what lets them in. Nothing here changes an action.
 */
export function SecurityActions({ data, filter, onFilter, open, onOpen }: { data: PostureResponse; filter: ActionFilter; onFilter: (f: ActionFilter) => void; /** The action whose people are shown, by id. */ open: string | null; onOpen: (id: string | null) => void }) {
  const who = useMemo(() => {
    const [kind, ...name] = (filter.person ?? '').split(':')
    return filter.person ? { kind: kind as 'person' | 'token', name: name.join(':') } : null
  }, [filter.person])
  const reach = usePostureReach(who)
  const runs = useMemo(() => (reach.data ? new Set(reach.data.actions.filter((a) => a.runs).map((a) => a.id)) : null), [reach.data])
  const people = useMemo(
    () => data.principals.map((p) => ({ id: `${p.kind}:${p.name}`, label: p.name, note: [p.kind === 'token' ? 'machine token' : p.signedIn ? 'signed in' : 'not signed in yet', p.admin ? 'admin' : null].filter(Boolean).join(' · '), group: p.admin ? 'Admins' : p.kind === 'token' ? 'Tokens' : 'People' })),
    [data.principals],
  )
  const teams = useMemo(() => teamsOf(data), [data])
  const audiences = useMemo(() => audiencesOf(data), [data])
  const backends = useMemo(() => backendsOf(data), [data])
  const all = useMemo(() => actionRows(data), [data])
  const shown = useMemo(() => shownActions(data, filter, runs), [data, filter, runs])
  if (!all.length) return <Empty>This hub has no actions yet.</Empty>
  const set = (patch: Partial<ActionFilter>) => onFilter({ ...filter, ...patch })
  const judging = !!who && !runs && !reach.error
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Picker label="A person or token" options={people} value={filter.person} placeholder="Type a name or an address" onChange={(id) => set({ person: id })} />
        <label className="block">
          <Kicker>Team</Kicker>
          <select className={`${input} mt-1`} value={filter.team} onChange={(e) => set({ team: e.target.value })}>
            <option value="">Any team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.words}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Kicker>Audience</Kicker>
          <select className={`${input} mt-1`} value={filter.audience} onChange={(e) => set({ audience: e.target.value })}>
            <option value="">Any audience</option>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Kicker>Backend</Kicker>
          <select className={`${input} mt-1`} value={filter.backend} onChange={(e) => set({ backend: e.target.value })}>
            <option value="">Any backend</option>
            {backends.map((b) => (
              <option key={b.id} value={b.id}>
                {b.word}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={filter.everyone} onChange={(e) => set({ everyone: e.target.checked })} />
          Open to everyone
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={filter.noApproval} onChange={(e) => set({ noApproval: e.target.checked })} />
          No approval
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={filter.neverRun} onChange={(e) => set({ neverRun: e.target.checked })} />
          Never run
        </label>
        {filtering(filter) && <Button onClick={() => onFilter(NO_FILTER)}>Clear filters</Button>}
      </div>
      <ErrorNote error={reach.error} />
      <p className="text-sm text-ink-400" aria-live="polite">
        {judging ? 'Working out what they may run…' : `${shown.length} of ${plural(all.length, 'action')}`}
      </p>
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="border-b border-ink-800 text-[12px] text-ink-400">
            <tr>
              <th className="w-8 px-3 py-2">
                <span className="sr-only">Who may run it</span>
              </th>
              <th className="px-2 py-2 font-medium">Action</th>
              <th className="px-2 py-2 font-medium">Home</th>
              <th className="px-2 py-2 font-medium">Who may run it</th>
              <th className="px-2 py-2 text-right font-medium">People</th>
              <th className="px-2 py-2 font-medium">Approval</th>
              <th className="px-2 py-2 font-medium">Backend</th>
              <th className="px-2 py-2 font-medium">Last run</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {shown.map((r) => (
              <Row key={r.id} row={r} open={open === r.id} onToggle={() => onOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
        {!shown.length && !judging && <p className="px-4 py-6 text-sm text-ink-400">No action matches.</p>}
      </Panel>
    </div>
  )
}

function Row({ row, open, onToggle }: { row: ActionRow; open: boolean; onToggle: () => void }) {
  const panel = `security-action-${row.id}`
  const home = row.home ? parseEntityId(row.home.id) : null
  return (
    <Fragment>
      <tr className="align-top">
        <td className="px-3 py-2">
          <button type="button" aria-expanded={open} aria-controls={panel} aria-label={`Who may run ${row.title}`} title="See who may run it" onClick={onToggle} className="inline-flex size-6 items-center justify-center rounded text-ink-400 hover:text-ink-100">
            {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
          </button>
        </td>
        <td className="px-2 py-2">
          <Link to={{ page: 'actions', id: row.id }} className="inline-flex items-center gap-2 text-ink-100 hover:underline">
            <Icon name={row.icon} className="size-4 shrink-0" />
            {row.title}
          </Link>
          <div className="font-mono text-[12px] text-ink-500">{row.id}</div>
        </td>
        <td className="px-2 py-2 text-ink-300">
          {row.home && home ? (
            <Link to={{ page: 'entity', ...home }} className="hover:underline">
              {row.home.title}
            </Link>
          ) : (
            <span className="text-ink-500">None</span>
          )}
        </td>
        <td className="px-2 py-2">
          <ul className="flex flex-wrap gap-1.5">
            {row.who.map((w, n) => (
              <li key={`${n}:${w}`}>
                <Badge>{w}</Badge>
              </li>
            ))}
          </ul>
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-ink-200">{row.people}</td>
        <td className="px-2 py-2 text-ink-300">{row.approval}</td>
        <td className="px-2 py-2 text-ink-300">{row.backend}</td>
        <td className="px-2 py-2 text-ink-300">
          {row.lastRunAt === undefined ? <span className="text-ink-500">Not known</span> : row.lastRunAt === null ? 'Never' : <span className="tabular-nums">{ago(row.lastRunAt)}</span>}
          {row.lastRunAt != null && row.runs90 !== undefined && <div className="text-[12px] text-ink-500 tabular-nums">{row.runs90} in 90 days</div>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLUMNS} className="bg-ink-950/40 px-4 py-3">
            <div id={panel} role="region" aria-label={`Who may run ${row.title}`}>
              <Who target={`action:${row.id}`} only />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}
