import { usePostureWho } from '../api.ts'
import { ErrorNote, Panel } from './ui.tsx'

/**
 * Everyone the hub knows against one blueprint, field, or action: whether
 * each sees or runs it, whether each changes it, and what lets them in.
 * `only` keeps the rows of those it lets in, for a list read beside the
 * thing itself.
 */
export function Who({ target, only = false }: { target: string; only?: boolean }) {
  const who = usePostureWho(target)
  if (who.error) return <ErrorNote error={who.error} />
  const w = who.data
  if (!w) return <p className="text-sm text-ink-400">Working it out…</p>
  const action = w.target.kind === 'action'
  const yes = w.rows.filter((r) => (action ? r.runs : r.sees))
  const rows = only ? yes : w.rows
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-300">
        <strong className="text-ink-100">{w.title}</strong>: {yes.length} of {w.rows.length} {action ? 'may run it' : 'may see it'}.
      </p>
      {rows.length > 0 && (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-ink-800 text-[12px] text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Who</th>
                {!only && <th className="px-2 py-2 font-medium">{action ? 'Runs' : 'Sees'}</th>}
                <th className="px-2 py-2 font-medium">{action ? 'Changes the action' : 'Changes it'}</th>
                <th className="px-2 py-2 font-medium">Through</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {rows.map((r) => (
                <tr key={`${r.principal.kind}:${r.principal.name}`}>
                  <td className="px-3 py-2 text-ink-100">
                    {r.principal.name}
                    <span className="text-ink-500">{r.principal.kind === 'token' ? ' token' : ''}{r.principal.admin ? ' admin' : ''}</span>
                  </td>
                  {!only && <td className="px-2 py-2">{yesNo(action ? r.runs : r.sees)}</td>}
                  <td className="px-2 py-2">{yesNo(r.changes)}</td>
                  <td className="px-2 py-2 text-ink-400">{r.via ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

function yesNo(v: boolean) {
  return <span className={v ? 'text-ink-100' : 'text-ink-500'}>{v ? 'Yes' : 'No'}</span>
}
