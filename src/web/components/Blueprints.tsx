import { useState } from 'react'
import type { Blueprint } from '../../shared/model.ts'
import { useAlertRules, useDeleteAlertRule, useDeleteRule, useRules, useSaveAlertRule, useSaveRule } from '../api.ts'
import { Badge, Button, ErrorNote, input, Kicker, Panel } from './ui.tsx'

export function RulesPanel({ canAuthor, blueprints }: { canAuthor: boolean; blueprints: Blueprint[] }) {
  const rules = useRules().data?.rules ?? []
  const save = useSaveRule()
  const remove = useDeleteRule()
  const [form, setForm] = useState({ id: '', blueprint: '', relation: '', where: '' })
  const bp = blueprints.find((b) => b.id === form.blueprint)
  const target = bp?.relations[form.relation]?.target
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Relation rules · {rules.length}</Kicker>
      </div>
      <div className="px-4 py-2 text-[12px] text-ink-400">Tagging-agnostic joins the hub evaluates continuously: link every entity of a blueprint to the target whose path equals its own. Changing a rule re-links the whole estate.</div>
      <ErrorNote error={save.error ?? remove.error} />
      <table className="w-full text-sm">
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-t border-ink-800">
              <td className="w-48 px-4 py-1.5 font-mono text-[12px]">{r.id}</td>
              <td className="px-2 py-1.5 font-mono text-[12px] text-ink-300">
                {r.blueprint}.{r.relation} → {r.match.target}
              </td>
              <td className="px-2 py-1.5 font-mono text-[12px] text-ink-300">{r.match.where}</td>
              <td className="w-24 px-2 py-1.5 text-right">
                {r.origin.kind === 'git' ? <Badge className="border-green/50 text-green">git</Badge> : canAuthor && <Button kind="danger" onClick={() => remove.mutate(r.id)}>Remove</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canAuthor && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-ink-800 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!target) return
            save.mutate({ id: form.id || `${form.blueprint}.${form.relation}`, spec: { blueprint: form.blueprint, relation: form.relation, match: { target, where: form.where } } }, { onSuccess: () => setForm({ id: '', blueprint: '', relation: '', where: '' }) })
          }}
        >
          <select className={input} aria-label="Blueprint" value={form.blueprint} onChange={(e) => setForm({ ...form, blueprint: e.target.value, relation: '' })} required>
            <option value="">blueprint</option>
            {blueprints.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id}
              </option>
            ))}
          </select>
          <select className={input} aria-label="Relation" value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} required>
            <option value="">relation</option>
            {Object.keys(bp?.relations ?? {}).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input className={`${input} w-96 font-mono text-[12px]`} aria-label="Where" placeholder="target.key == source.tags['app-name']" value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })} required />
          <Button type="submit" kind="solid" disabled={!target || save.isPending}>
            Add rule
          </Button>
        </form>
      )}
    </Panel>
  )
}

export function AlertRulesPanel({ canAuthor, blueprints }: { canAuthor: boolean; blueprints: Blueprint[] }) {
  const rules = useAlertRules().data?.rules ?? []
  const save = useSaveAlertRule()
  const remove = useDeleteAlertRule()
  const [form, setForm] = useState({ blueprint: '', where: '' })
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Alert rules · {rules.length}</Kicker>
      </div>
      <div className="px-4 py-2 text-[12px] text-ink-400">How Alertmanager alerts attach to entities: the entity whose path equals an alert label. Firing alerts turn the entity red (severity critical) or amber.</div>
      <ErrorNote error={save.error ?? remove.error} />
      <table className="w-full text-sm">
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-t border-ink-800">
              <td className="w-48 px-4 py-1.5 font-mono text-[12px]">{r.id}</td>
              <td className="px-2 py-1.5 font-mono text-[12px] text-ink-300">{r.blueprint}</td>
              <td className="px-2 py-1.5 font-mono text-[12px] text-ink-300">{r.where}</td>
              <td className="w-24 px-2 py-1.5 text-right">
                {r.origin.kind === 'git' ? <Badge className="border-green/50 text-green">git</Badge> : canAuthor && <Button kind="danger" onClick={() => remove.mutate(r.id)}>Remove</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canAuthor && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-ink-800 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ id: `${form.blueprint}.alerts`, spec: { blueprint: form.blueprint, where: form.where } }, { onSuccess: () => setForm({ blueprint: '', where: '' }) })
          }}
        >
          <select className={input} aria-label="Blueprint" value={form.blueprint} onChange={(e) => setForm({ ...form, blueprint: e.target.value })} required>
            <option value="">blueprint</option>
            {blueprints.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id}
              </option>
            ))}
          </select>
          <input className={`${input} w-96 font-mono text-[12px]`} aria-label="Where" placeholder="target.name == alert.labels['namespace']" value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })} required />
          <Button type="submit" kind="solid" disabled={save.isPending}>
            Add alert rule
          </Button>
        </form>
      )}
    </Panel>
  )
}
