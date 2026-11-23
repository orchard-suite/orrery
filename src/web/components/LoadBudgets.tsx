import { BUDGET_KINDS, type BudgetKind, type Budgets } from '../../shared/api.ts'
import { count } from '../../shared/load-signals.ts'
import { useCan, useSaveBudgets } from '../api.ts'
import { Button, ErrorNote, input, mono } from './ui.tsx'

const KIND: Record<BudgetKind, { title: string; who: string; counts: string }> = {
  changes: { title: 'Source changes', who: 'Source id', counts: 'Entities a source changes in an hour. Past the limit its writes are refused until the hour turns.' },
  calls: { title: 'Caller calls', who: 'Caller', counts: 'API calls a caller makes in an hour. Past the limit a token is refused until the hour turns. A person never is.' },
  entities: { title: 'Blueprint entities', who: 'Blueprint id', counts: 'Entities a blueprint holds. Past the limit new ones are refused.' },
  reads: { title: 'Blueprint reads', who: 'Blueprint id', counts: 'Entities one row of a blueprint reads, on average. Nothing is refused for it: both numbers raise a finding.' },
}

/** One budget as its row is typed. */
export interface BudgetRow {
  kind: BudgetKind
  name: string
  warn: string
  limit: string
}

export const rowsOf = (budgets: Budgets): BudgetRow[] => BUDGET_KINDS.flatMap((kind) => Object.entries(budgets[kind]).map(([name, b]) => ({ kind, name, warn: b.warn?.toString() ?? '', limit: b.limit?.toString() ?? '' })))

/** The rows as budgets, or what is wrong with the first row that cannot be one. */
function budgetsOf(rows: BudgetRow[]): Budgets | string {
  const out: Budgets = { changes: {}, calls: {}, entities: {}, reads: {} }
  for (const r of rows) {
    const name = r.name.trim()
    const whole = (text: string) => (text.trim() === '' ? undefined : Number(text))
    const warn = whole(r.warn)
    const limit = whole(r.limit)
    if (!name) return 'Every budget needs a name, or * for all.'
    if (name in out[r.kind]) return `${KIND[r.kind].title} has two budgets for ${name}.`
    for (const n of [warn, limit]) if (n !== undefined && (!Number.isInteger(n) || n <= 0)) return `${name}: a budget is a whole number above zero.`
    if (warn === undefined && limit === undefined) return `${name}: set a warning, a limit, or both.`
    if (warn !== undefined && limit !== undefined && warn > limit) return `${name}: the warning must not be above the limit.`
    out[r.kind][name] = { ...(warn === undefined ? {} : { warn }), ...(limit === undefined ? {} : { limit }) }
  }
  return out
}

/** The budgets as they are held, and for whoever may set them, the same rows to change, add to, and save. The draft is the page's, so a signal can add a row to it. */
export function BudgetsTable({ budgets, draft, setDraft }: { budgets: Budgets; draft: BudgetRow[] | null; setDraft: (rows: BudgetRow[] | null) => void }) {
  const may = useCan('budgets.set')
  const save = useSaveBudgets()
  const rows = draft ?? rowsOf(budgets)
  const next = draft ? budgetsOf(draft) : budgets
  const change = (i: number, patch: Partial<BudgetRow>) => setDraft(rows.map((r, at) => (at === i ? { ...r, ...patch } : r)))
  const th = 'label px-3 py-2 text-left whitespace-nowrap first:pl-4'
  const td = 'px-3 py-1.5 first:pl-4'
  const number = `${input} w-28 text-right tabular-nums`
  return (
    <>
      <p className="border-b border-ink-800 px-4 py-2.5 text-[13px] text-ink-400">Past its warning a finding is raised. Past its limit the hub refuses what would add to it, and says why. The name * is every one that has no budget of its own.</p>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Budgets</caption>
            <thead>
              <tr className="border-b border-ink-800">
                <th scope="col" className={th}>
                  Counts
                </th>
                <th scope="col" className={th}>
                  For
                </th>
                <th scope="col" className={th}>
                  Warns at
                </th>
                <th scope="col" className={th}>
                  Refuses at
                </th>
                {may && <th scope="col" className={th} />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-ink-800 last:border-b-0">
                  <td className={td} title={KIND[r.kind].counts}>
                    {may ? (
                      <select className={input} aria-label="What the budget counts" value={r.kind} onChange={(e) => change(i, { kind: e.target.value as BudgetKind })}>
                        {BUDGET_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {KIND[kind].title}
                          </option>
                        ))}
                      </select>
                    ) : (
                      KIND[r.kind].title
                    )}
                  </td>
                  <td className={td}>{may ? <input className={`${input} ${mono} w-56`} aria-label={KIND[r.kind].who} placeholder={`${KIND[r.kind].who}, or *`} value={r.name} onChange={(e) => change(i, { name: e.target.value })} /> : <span className={mono}>{r.name}</span>}</td>
                  <td className={td}>{may ? <input className={number} inputMode="numeric" aria-label="Warns at" value={r.warn} onChange={(e) => change(i, { warn: e.target.value })} /> : r.warn ? count(Number(r.warn)) : 'Never'}</td>
                  <td className={td}>{may ? <input className={number} inputMode="numeric" aria-label="Refuses at" value={r.limit} onChange={(e) => change(i, { limit: e.target.value })} /> : r.limit ? count(Number(r.limit)) : 'Never'}</td>
                  {may && (
                    <td className={`${td} text-right`}>
                      <Button onClick={() => setDraft(rows.filter((_, at) => at !== i))}>Remove</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {may && (
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-4 py-2">
          <Button onClick={() => setDraft([...rows, { kind: 'changes', name: '', warn: '', limit: '' }])}>Add a budget</Button>
          {draft && (
            <>
              <Button kind="solid" disabled={typeof next === 'string' || save.isPending} onClick={() => typeof next !== 'string' && save.mutate(next, { onSuccess: () => setDraft(null) })}>
                Save
              </Button>
              <Button onClick={() => setDraft(null)}>Discard</Button>
              {typeof next === 'string' && <span className="text-[13px] text-amber">{next}</span>}
            </>
          )}
          <ErrorNote error={save.error} />
        </div>
      )}
    </>
  )
}
