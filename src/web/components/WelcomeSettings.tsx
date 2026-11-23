// What the estate sets of the welcome tour, on the Access page: which
// catalog, entity, and action it shows, and the words of each step. The
// steps and their order are the hub's. A git source that declares the tour
// under `config.welcome` owns it, and then it is read here, not changed.
// Saved as it is changed.

import { useState } from 'react'
import { TOUR_STEPS, TOUR_STEP_IDS, WELCOME_LIMITS, type TourStepId, type WelcomeDef, type WelcomeStepDef } from '../../shared/welcome.ts'
import { useActions, useBlueprints, useSaveWelcome, useWelcomeSettings } from '../api.ts'
import { askFor } from './Welcome.tsx'
import type { ActionView } from '../../shared/api.ts'
import { Button, ErrorNote, Fold, input } from './ui.tsx'

export function WelcomeSettings() {
  const settings = useWelcomeSettings(true)
  const save = useSaveWelcome()
  const blueprints = useBlueprints().data?.blueprints ?? []
  const actions = useActions().data?.actions ?? []
  const held = settings.data?.welcome
  const owner = held?.source ?? null
  const locked = !!owner || save.isPending
  const change = (patch: Partial<WelcomeDef>) => {
    if (!held) return
    const { source: _source, ...rest } = held
    save.mutate({ ...rest, ...patch })
  }
  const changeStep = (id: TourStepId, patch: WelcomeStepDef) => change({ steps: { ...held?.steps, [id]: { ...held?.steps?.[id], ...patch } } })
  return (
    <Fold title="Welcome tour" summary={held && `Version ${held.version}${owner ? ` · declared by ${owner}` : ''}`}>
      <div className="space-y-4 px-4 py-3">
        <p className="max-w-3xl text-sm text-ink-400">The tour a person is shown on their first visit. Pick what it shows of this estate and change what each step says. A step that shows something a person may not see is left out for them, and a pick they may not see becomes the first they may.</p>
        {owner && <p className="max-w-3xl text-sm text-ink-200">The git source "{owner}" declares this tour under <code className="font-mono text-[13px]">config.welcome</code>. Change it there.</p>}
        <ErrorNote error={settings.error ?? save.error} />
        {held && (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block text-sm text-ink-200">
                Catalog to show
                <select className={`${input} mt-1 block w-56`} value={held.blueprint ?? ''} disabled={locked} onChange={(e) => change({ blueprint: e.target.value || undefined, example: undefined })}>
                  <option value="">The first each person sees</option>
                  {blueprints.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.title}
                    </option>
                  ))}
                </select>
              </label>
              <Saved label="Key of an entity to open" value={held.example ?? ''} disabled={locked || !held.blueprint} max={500} placeholder={held.blueprint ? 'none' : 'pick a catalog first'} onSave={(example) => change({ example: example || undefined })} />
            </div>
            <Ranked picked={held.actions ?? []} actions={actions} disabled={locked} onChange={(next) => change({ actions: next.length ? next : undefined })} />
            <fieldset className="max-w-4xl space-y-3">
              <legend className="text-sm font-semibold text-ink-100">Steps</legend>
              <p className="text-[13px] text-ink-400">
                A step's text may name <code className="font-mono">{'{{ blueprint }}'}</code>, <code className="font-mono">{'{{ entity }}'}</code>, and <code className="font-mono">{'{{ action }}'}</code>. Leave a box empty to keep the hub's words.
              </p>
              <ol className="space-y-3">
                {TOUR_STEP_IDS.map((id, n) => {
                  const own = held.steps?.[id]
                  const shown = own?.shown !== false
                  const base: { title: string; text: string; empty?: string } = TOUR_STEPS[id]
                  return (
                    <li key={id} className="grid gap-2 rounded-lg border border-ink-800 p-3 md:grid-cols-[10rem_minmax(0,1fr)]">
                      <label className="flex min-h-6 items-start gap-2 text-sm text-ink-200">
                        <input type="checkbox" className="mt-1" checked={shown} disabled={locked} onChange={(e) => changeStep(id, { shown: e.target.checked ? undefined : false })} />
                        <span>
                          {n + 1}. {TOUR_STEPS[id].title}
                        </span>
                      </label>
                      <div className="space-y-2">
                        <Saved label={`Title of step ${n + 1}`} hideLabel value={own?.title ?? ''} placeholder={TOUR_STEPS[id].title} disabled={locked || !shown} max={WELCOME_LIMITS.title} onSave={(title) => changeStep(id, { title: title || undefined })} />
                        <Saved label={`Text of step ${n + 1}`} hideLabel multiline value={own?.text ?? ''} placeholder={TOUR_STEPS[id].text} disabled={locked || !shown} max={WELCOME_LIMITS.text} onSave={(text) => changeStep(id, { text: text || undefined })} />
                        {base.empty && <Saved label="For a person who may run no action" multiline value={own?.empty ?? ''} placeholder={base.empty} disabled={locked || !shown} max={WELCOME_LIMITS.text} onSave={(empty) => changeStep(id, { empty: empty || undefined })} />}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={locked} onClick={() => change({ version: held.version + 1 })} title="Everyone who finished or left this tour is shown it once more on their next visit">
                Show it again to everyone
              </Button>
              <Button onClick={() => askFor('tour')}>Take the tour</Button>
              <span className="text-[13px] text-ink-400">Version {held.version}</span>
            </div>
          </>
        )}
      </div>
    </Fold>
  )
}

/** A text the tour's settings take, saved when it loses focus and has changed. */
function Saved({ label, hideLabel = false, value, placeholder, disabled, max, multiline = false, onSave }: { label: string; hideLabel?: boolean; value: string; placeholder: string; disabled: boolean; max: number; multiline?: boolean; onSave: (value: string) => void }) {
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? value
  const done = () => {
    if (typed !== null && typed.trim() !== value) onSave(typed.trim())
    setTyped(null)
  }
  const props = { className: `${input} mt-1 block w-full placeholder:text-ink-500`, value: shown, placeholder, disabled, maxLength: max, onChange: (e: { target: { value: string } }) => setTyped(e.target.value), onBlur: done }
  return (
    <label className={`block text-sm text-ink-200 ${multiline ? '' : 'min-w-[min(100%,14rem)]'}`}>
      <span className={hideLabel ? 'sr-only' : ''}>{label}</span>
      {multiline ? <textarea rows={2} {...props} className={`${props.className} field-sizing-content resize-none`} /> : <input type="text" {...props} />}
    </label>
  )
}

/**
 * The actions the tour may show, best first. Each person is shown the first
 * of them they may run; one who may run none of them is shown the first
 * action they may run at all.
 */
function Ranked({ picked, actions, disabled, onChange }: { picked: string[]; actions: ActionView[]; disabled: boolean; onChange: (next: string[]) => void }) {
  const title = (id: string) => actions.find((a) => a.id === id)?.title ?? id
  const move = (from: number, to: number) => {
    const next = [...picked]
    const [id] = next.splice(from, 1)
    next.splice(to, 0, id!)
    onChange(next)
  }
  const left = actions.filter((a) => !picked.includes(a.id))
  return (
    <fieldset className="max-w-3xl space-y-2">
      <legend className="text-sm text-ink-200">Actions to show, best first</legend>
      <p className="text-[13px] text-ink-400">Each person is shown the first of these they may run. One who may run none of them is shown the first action they may run, and one who may run no action is told how they get one.</p>
      {picked.length > 0 && (
        <ol className="space-y-1">
          {picked.map((id, n) => (
            <li key={id} className="flex items-center gap-2 rounded-lg border border-ink-800 px-3 py-1.5 text-sm text-ink-100">
              <span className="w-5 text-ink-400">{n + 1}.</span>
              <span className="min-w-0 flex-1 truncate">{title(id)}</span>
              <button type="button" className="btn btn-ghost" disabled={disabled || n === 0} aria-label={`Move ${title(id)} up`} onClick={() => move(n, n - 1)}>
                Up
              </button>
              <button type="button" className="btn btn-ghost" disabled={disabled || n === picked.length - 1} aria-label={`Move ${title(id)} down`} onClick={() => move(n, n + 1)}>
                Down
              </button>
              <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`Remove ${title(id)}`} onClick={() => onChange(picked.filter((p) => p !== id))}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {picked.length < WELCOME_LIMITS.actions && (
        <label className="block text-sm text-ink-200">
          <span className="sr-only">Add an action</span>
          <select className={`${input} block w-64`} value="" disabled={disabled || !left.length} onChange={(e) => e.target.value && onChange([...picked, e.target.value])}>
            <option value="">{picked.length ? 'Add another action' : 'Add an action'}</option>
            {left.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  )
}
