// Where something belongs: one entity of any blueprint, its home. An action
// and a saved query both name one. A person picks the blueprint, then finds
// the entity in it, or takes the thing off its home.

import { useState } from 'react'
import { entityId, parseEntityId, type Blueprint } from '../../shared/model.ts'
import { useBlueprintName } from '../api.ts'
import { RelationEditor } from './editors.tsx'
import { Button, input } from './ui.tsx'

/** The home's blueprint and key, as a person reads them where its title is not at hand. */
export function HomeRef({ value }: { value: string }) {
  const name = useBlueprintName()
  const ref = parseEntityId(value)
  if (!ref) return <>{value}</>
  return (
    <>
      {`${name(ref.blueprint)}: `}
      <span className="font-mono text-[12px]">{ref.key}</span>
    </>
  )
}

/** The controls that pick a home or take it off: a blueprint, then a search of its entities. */
export function HomePicker({ value, blueprints, onChange }: { value: string | null; blueprints: readonly Blueprint[]; onChange: (v: string | null) => void }) {
  const ref = value ? parseEntityId(value) : null
  const [chosen, setChosen] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const target = chosen ?? ref?.blueprint ?? blueprints[0]?.id ?? ''
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select aria-label="The blueprint of its home" className={input} value={target} onChange={(e) => setChosen(e.target.value)}>
        {!blueprints.some((b) => b.id === target) && <option value={target}>{target}</option>}
        {blueprints.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title ?? b.id}
          </option>
        ))}
      </select>
      <Button opens="dialog" disabled={!target} onClick={(e) => setAnchor(e.currentTarget)}>
        {value ? 'Change its home' : 'Pick its home'}
      </Button>
      {value && <Button onClick={() => onChange(null)}>Take it off its home</Button>}
      {anchor && <RelationEditor anchor={anchor} place="below" target={target} many={false} value={ref && ref.blueprint === target ? [ref] : []} onCommit={(to) => (onChange(to[0] ? entityId(to[0]) : null), setAnchor(null))} onClose={() => setAnchor(null)} />}
    </span>
  )
}
