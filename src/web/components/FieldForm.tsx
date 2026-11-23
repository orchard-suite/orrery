import { Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useBlueprintName, useIsAdmin, usePolicy, usePreview, useSaveBlueprint } from '../api.ts'
import { classFor } from '../../shared/policy.ts'
import { withBudget } from '../ground.ts'
import { Icon } from '../icons.tsx'
import { AccessEditor } from './AccessEditor.tsx'
import { IconPicker } from './editors.tsx'
import { AGGREGATION_FNS, AGGREGATION_PERIODS, FIELD_TYPES, isSpread, mayChip, maySpread, PIVOT_LIMIT, VALUE_COLORS, type AggregationDef, type Blueprint, type FieldDef, type ValueColor } from '../../shared/model.ts'
import { MenuItem, Popover } from './Popover.tsx'
import { Button, Chip, ErrorNote, input, Kicker, Link, swatch } from './ui.tsx'

/** What a blueprint is saved as: itself without the hub's bookkeeping. */
export function specOf(bp: Blueprint): Omit<Blueprint, 'origin' | 'updatedAt'> {
  const { origin: _origin, updatedAt: _updatedAt, ...spec } = bp
  return spec
}

/** The name a new field or relation may take: lower case, digits, and underscores, starting with a letter. */
export const NAME = /^[a-z][a-z0-9_]*$/

/**
 * One field's definition, changed or added where it is shown: on a column's
 * heading in the grid, or on a card on the model page. `name` null adds a
 * field. Saving changes the blueprint at once.
 */
export function FieldPopover({ bp, name, anchor, onClose }: { bp: Blueprint; name: string | null; anchor: HTMLElement; onClose: () => void }) {
  const save = useSaveBlueprint()
  const admin = useIsAdmin()
  const blueprintName = useBlueprintName()
  const [def, setDef] = useState<FieldDef>(() => (name ? structuredClone(bp.fields[name]!) : { type: 'string' }))
  const [newName, setNewName] = useState('')
  const key = name ?? newName
  const named = !!name || (NAME.test(newName) && !(newName in bp.fields) && newName !== 'title')
  const dirty = name ? JSON.stringify(def) !== JSON.stringify(bp.fields[name]) : !!newName
  return (
    // A press outside keeps the popover open while it holds changes, so nothing typed is lost to a stray click.
    <Popover anchor={anchor} width={460} onClose={onClose} onOutside={dirty ? () => {} : onClose} unsaved={dirty} label={name ? `Edit property ${def.title || name}` : `New property on ${blueprintName(bp)}`} className="max-h-[85vh] w-[460px] space-y-3 overflow-y-auto p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Kicker>{name ? 'Edit property' : 'New property'}</Kicker>
          <div className="truncate text-sm font-semibold">{def.title || key || 'Untitled'}</div>
          <div className="font-mono text-[12px] text-ink-400">
            {blueprintName(bp)}
            {name && ` · ${name}`}
          </div>
        </div>
        <button className="-m-1.5 p-1.5 text-ink-500 hover:text-ink-100" title="Close without saving" aria-label="Close without saving" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {!name && (
        <label className="block">
          <Kicker>Name</Kicker>
          <input className={`${input} mt-1 w-full font-mono`} value={newName} onChange={(e) => setNewName(e.target.value.trim())} placeholder="field_name" autoFocus />
          {newName && !named && <span className="mt-1 block text-[12px] text-ink-400">{newName in bp.fields || newName === 'title' ? 'Taken: pick another name.' : 'Lower case letters, digits, and underscores, starting with a letter.'}</span>}
        </label>
      )}
      <FieldForm def={def} onChange={setDef} />
      {admin && <FieldAccess blueprint={bp.id} name={key} def={def} onChange={setDef} />}
      <ErrorNote error={save.error} />
      <div className="flex gap-2">
        <Button kind="solid" disabled={!dirty || !named || save.isPending} onClick={() => save.mutate({ id: bp.id, spec: { ...specOf(bp), fields: { ...bp.fields, [key]: def } } }, { onSuccess: onClose })}>
          {name ? 'Save' : 'Add property'}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        {name && (
          <Button
            kind="danger"
            className="ml-auto"
            disabled={save.isPending}
            onClick={() => {
              if (!confirm(`Delete the property ${bp.fields[name]?.title ?? name}? Its values are kept, but no view shows them.`)) return
              const { [name]: _gone, ...fields } = bp.fields
              save.mutate({ id: bp.id, spec: { ...specOf(bp), fields } }, { onSuccess: onClose })
            }}
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </Button>
        )}
      </div>
    </Popover>
  )
}

/** Who sees a field and who changes it. Only an admin sets either. A field in a class is seen by the class's audiences, set on the Security page. */
export function FieldAccess({ blueprint, name, def, onChange }: { blueprint: string; name: string; def: FieldDef; onChange: (def: FieldDef) => void }) {
  const policy = usePolicy(true).data?.policy
  const cls = policy && name ? classFor(policy, blueprint, name) : null
  return (
    <div className="space-y-2 rounded-sm border border-ink-800 p-2">
      <Kicker>Who sees this field</Kicker>
      {cls ? (
        <p className="text-[12px] text-ink-300">
          In the <strong className="text-ink-100">{cls.title}</strong> class, so {cls.audiences.map((id) => policy!.audiences.find((a) => a.id === id)?.title ?? id).join(' and ')} see it, wherever it appears. Change who sees it on the class, on the <Link to={{ page: 'security' }} className="underline">Security page</Link>.
        </p>
      ) : (
        <AccessEditor value={def.access} onChange={(rule) => onChange(rule ? { ...def, access: rule } : withoutKey(def, 'access'))} what="this field" />
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!def.adminEdit} onChange={(e) => onChange(e.target.checked ? { ...def, adminEdit: true } : withoutKey(def, 'adminEdit'))} /> only an admin changes this field
      </label>
      {def.aggregation && (def.type === 'number' || def.type === 'trend') && (
        <label className="flex items-start gap-2 text-sm" title="Without this, the result is hidden from anyone who may not see the entities it reads">
          <input type="checkbox" className="mt-1 shrink-0" checked={!!def.summary} onChange={(e) => onChange(e.target.checked ? { ...def, summary: true } : withoutKey(def, 'summary'))} />
          <span>a summary: show the result to everyone who sees this field, and nothing of what it reads</span>
        </label>
      )}
    </div>
  )
}

function withoutKey(def: FieldDef, key: 'access' | 'adminEdit' | 'summary'): FieldDef {
  const { [key]: _drop, ...rest } = def
  return rest
}

/** A field as another type. Only a number has a budget, so one does not follow the field to another type. */
export function withType(def: FieldDef, type: FieldDef['type']): FieldDef {
  const { budget, chip, spread, ...rest } = def
  // A chip and a count go with a kind that may take them; any other kind does not keep the mark.
  const kept = { ...rest, ...(chip && mayChip(type) ? { chip } : {}), ...(spread !== undefined && maySpread(type) ? { spread } : {}) }
  return type === 'number' && budget ? { ...kept, type, budget } : { ...kept, type }
}

/** A field counted under the grid or not: the mark is kept only where it says other than the kind does by default. */
export function withSpread(def: FieldDef, on: boolean): FieldDef {
  const { spread: _, ...rest } = def
  return isSpread(rest) === on ? rest : { ...rest, spread: on }
}

/** Everything a field's definition says, as a form: the model page and the grid's column menu both edit a field with it. */
export function FieldForm({ def, onChange, className = '' }: { def: FieldDef; onChange: (def: FieldDef) => void; className?: string }) {
  const agg = def.aggregation
  const setAgg = (patch: Partial<AggregationDef>) => agg && onChange({ ...def, aggregation: { ...agg, ...patch } })
  // The ground reads a budget, and the ground is a preview: only its readers set one here.
  const ground = usePreview('garden')
  return (
    <div className={`grid grid-cols-1 gap-2 md:grid-cols-2 ${className}`}>
      <label className="block">
        <Kicker>Type</Kicker>
        <select className={`${input} mt-1 w-full`} value={def.type} onChange={(e) => onChange(withType(def, e.target.value as FieldDef['type']))}>
          {FIELD_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <Kicker>Title</Kicker>
        <input className={`${input} mt-1 w-full`} value={def.title ?? ''} onChange={(e) => onChange({ ...def, title: e.target.value || undefined })} />
      </label>
      <label className="md:col-span-2 block">
        <Kicker>Description</Kicker>
        <input className={`${input} mt-1 w-full`} value={def.description ?? ''} onChange={(e) => onChange({ ...def, description: e.target.value || undefined })} />
      </label>
      {def.type === 'enum' && (
        <label className="md:col-span-2 block">
          <Kicker>Values</Kicker>
          <ParsedInput
            className={`${input} mt-1 w-full font-mono`}
            value={(def.values ?? []).join(', ')}
            onChange={(text) => {
              const values = text.split(',').map((s) => s.trim()).filter(Boolean)
              // A colour goes with the value it was picked for.
              const colors = Object.fromEntries(Object.entries(def.colors ?? {}).filter(([v]) => values.includes(v)))
              onChange({ ...def, values, colors: Object.keys(colors).length ? colors : undefined })
            }}
          />
        </label>
      )}
      {mayChip(def.type) && (
        <label className="md:col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="shrink-0" checked={!!def.chip} onChange={(e) => onChange({ ...def, chip: e.target.checked || undefined, colors: e.target.checked ? def.colors : undefined })} /> <span><span className="font-medium text-ink-100">Chip</span>: show each value as a coloured chip</span>
        </label>
      )}
      {maySpread(def.type) && (
        <label className="md:col-span-2 flex items-center gap-2 text-sm" title="Counting a column of many different values costs every grid build and draws slivers; a chip keeps its look without it">
          <input type="checkbox" className="shrink-0" checked={isSpread(def)} onChange={(e) => onChange(withSpread(def, e.target.checked))} /> <span><span className="font-medium text-ink-100">Count under the grid</span>: draw how its values share out the rows, and pick a filter's value from them</span>
        </label>
      )}
      {def.type === 'number' && (
        <label className="md:col-span-2 block" title="Shows the number as money. The number is stored in the currency's smallest unit, such as cents, so it still sorts, filters, and adds exactly">
          <Kicker>Currency</Kicker>
          <ParsedInput
            className={`${input} mt-1 w-full font-mono`}
            value={def.format?.currency ?? ''}
            placeholder="USD: show whole cents as dollars. Empty shows the plain number"
            onChange={(text) => {
              // Only a whole code is a format; a half-typed one changes nothing yet.
              const code = text.trim().toUpperCase()
              if (!code) onChange({ ...def, format: undefined })
              else if (/^[A-Z]{3}$/.test(code)) onChange({ ...def, format: { kind: 'currency', currency: code, minor: true } })
            }}
          />
        </label>
      )}
      {def.type === 'number' && ground && (
        <fieldset className="grid grid-cols-2 gap-2 md:col-span-2" title="The range this number should stay in. Nothing is refused for it: the ground shows what is outside it. It is not a load budget, which limits what a source may send">
          <legend className="sr-only">Budget</legend>
          <label className="block">
            <Kicker>Budget: at least</Kicker>
            <ParsedInput className={`${input} mt-1 w-full font-mono`} value={def.budget?.min?.toString() ?? ''} placeholder="No floor" onChange={(text) => onChange(withBudget(def, 'min', text))} />
          </label>
          <label className="block">
            <Kicker>Budget: at most</Kicker>
            <ParsedInput className={`${input} mt-1 w-full font-mono`} value={def.budget?.max?.toString() ?? ''} placeholder="No ceiling" onChange={(text) => onChange(withBudget(def, 'max', text))} />
          </label>
        </fieldset>
      )}
      {def.type === 'enum' && (
        <label className="md:col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="shrink-0" checked={!!def.many} onChange={(e) => onChange({ ...def, many: e.target.checked || undefined })} /> <span><span className="font-medium text-ink-100">List</span>: holds several of the values at once, such as the skills a person has</span>
        </label>
      )}
      {(def.type === 'enum' || def.type === 'boolean' || def.chip) && <ColorsField def={def} onChange={onChange} />}
      {def.type === 'url' && <LinkIconField def={def} onChange={onChange} />}
      {def.type === 'url' && (
        <label className="md:col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="shrink-0" checked={!!def.many} onChange={(e) => onChange({ ...def, many: e.target.checked || undefined })} /> <span><span className="font-medium text-ink-100">List</span>: holds several links, each drawn as its own mark</span>
        </label>
      )}
      {def.type === 'object' && (
        <label className="md:col-span-2 flex items-start gap-2 text-sm" title={`The hub makes a field for each property it meets, up to ${PIVOT_LIMIT}, and takes them away again when this is cleared. Hide the columns you do not want`}>
          <input type="checkbox" className="mt-1" checked={!!def.pivot} onChange={(e) => onChange({ ...def, pivot: e.target.checked || undefined })} />
          <span><span className="font-medium text-ink-100">Pivot</span>: give each property a field of its own, to show as a column, filter on, and match in a relation rule</span>
        </label>
      )}
      {def.pivoted && (
        <div className="md:col-span-2 font-mono text-[12px] text-ink-400">
          Pivoted out of {def.pivoted.field}: the "{def.pivoted.key}" property. It goes when {def.pivoted.field} stops being pivoted.
        </div>
      )}
      <label className="md:col-span-2 block">
        <Kicker>Calculation</Kicker>
        <input className={`${input} mt-1 w-full font-mono`} value={def.calculation ?? ''} onChange={(e) => onChange({ ...def, calculation: e.target.value || undefined })} placeholder="days_until(expires), 'https://grafana.example.org/d/' + key" />
      </label>
      <label className="block">
        <Kicker>Mirror</Kicker>
        <input className={`${input} mt-1 w-full font-mono`} value={def.mirror ?? ''} onChange={(e) => onChange({ ...def, mirror: e.target.value || undefined })} placeholder="system.owner, team.department.title" />
      </label>
      <label className="block">
        <Kicker>Aggregation</Kicker>
        <ParsedInput
          className={`${input} mt-1 w-full font-mono`}
          value={agg ? `${agg.fn} ${agg.relation}${agg.field ? ` ${agg.field}` : ''}` : ''}
          onChange={(text) => {
            const [fn, relation, field] = text.trim().split(/\s+/)
            onChange({ ...def, aggregation: fn && relation && (AGGREGATION_FNS as readonly string[]).includes(fn) ? { ...agg, fn: fn as AggregationDef['fn'], relation, field: field || undefined } : undefined })
          }}
          placeholder="count <-system, sum <-service:team.<-resource:service cost"
        />
      </label>
      {agg && (
        <>
          <label className="block" title="Only count related entities whose datetime field falls in the last so long: deployed_at 30d. A third value moves the window back: deployed_at 30d 30d is the thirty days before the last thirty">
            <Kicker>Window</Kicker>
            <ParsedInput
              className={`${input} mt-1 w-full font-mono`}
              value={agg.window ? [agg.window.field, agg.window.last, agg.window.offset].filter(Boolean).join(' ') : ''}
              onChange={(text) => {
                const [field, last, offset] = text.trim().split(/\s+/)
                setAgg({ window: field && last ? { field, last, ...(offset ? { offset } : {}) } : undefined, per: field && last ? agg.per : undefined })
              }}
              placeholder="deployed_at 30d"
            />
          </label>
          <label className="block" title="Turn the count or sum over the window into a rate">
            <Kicker>Rate per</Kicker>
            <select className={`${input} mt-1 w-full`} value={agg.per ?? ''} disabled={!agg.window} onChange={(e) => setAgg({ per: (e.target.value || undefined) as AggregationDef['per'] })}>
              <option value="">a total, not a rate</option>
              {Object.keys(AGGREGATION_PERIODS).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="md:col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" className="shrink-0" checked={def.overridable === false} onChange={(e) => onChange({ ...def, overridable: e.target.checked ? false : undefined, sticky: e.target.checked ? undefined : def.sticky })} /> <span><span className="font-medium text-ink-100">Locked</span>: only sources write it; nobody sets or changes it in the web app</span>
      </label>
      <label className={`md:col-span-2 flex items-center gap-2 text-sm ${def.overridable === false ? 'text-ink-500' : ''}`} title={def.overridable === false ? 'A locked field takes no change from a person, so there is nothing to keep' : "Left clear, a person's change gives way when the source pushes a different value"}>
        <input type="checkbox" className="shrink-0" checked={!!def.sticky} disabled={def.overridable === false} onChange={(e) => onChange({ ...def, sticky: e.target.checked || undefined })} /> <span><span className="font-medium text-ink-100">Sticky</span>: a person's change stays when a source pushes a different value</span>
      </label>
    </div>
  )
}

/**
 * A text box for a value parsed out of what is typed. It keeps the text as
 * typed while it has focus, so a comma or space that does not parse yet stays
 * put, and shows the parsed value again once it loses focus.
 */
export function ParsedInput({ value, onChange, ...rest }: { value: string; onChange: (text: string) => void; className?: string; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      {...rest}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => (setDraft(e.target.value), onChange(e.target.value))}
      onBlur={() => setDraft(null)}
    />
  )
}

/** The icon a url field's links are drawn as: the site's logo unless a person picks one, or none to show the address. */
function LinkIconField({ def, onChange }: { def: FieldDef; onChange: (def: FieldDef) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const set = (icon: string | false | undefined) => (onChange({ ...def, icon }), setAnchor(null))
  const resets = [
    ...(def.icon !== undefined ? [{ label: "The site's logo", run: () => set(undefined) }] : []),
    ...(def.icon !== false ? [{ label: 'No icon: show the address', run: () => set(false) }] : []),
  ]
  return (
    <div className="md:col-span-2">
      <Kicker>Link icon</Kicker>
      <button type="button" className={`${input} mt-1 flex w-full items-center gap-2 text-left font-mono`} onClick={(e) => setAnchor(e.currentTarget)}>
        {def.icon ? <Icon name={def.icon} className="size-4 shrink-0 text-ink-200" /> : null}
        <span className="truncate">{def.icon || (def.icon === false ? 'none: show the address' : "the site's logo, where the hub knows the site")}</span>
      </button>
      {anchor && <IconPicker anchor={anchor} value={def.icon || null} onPick={set} resets={resets} onClose={() => setAnchor(null)} />}
    </div>
  )
}

/**
 * The colour of each value a field takes, picked from the palette. A value
 * left alone wears the colour it gets anyway. A chip field takes any value,
 * so its values are named here before they get a colour.
 */
function ColorsField({ def, onChange }: { def: FieldDef; onChange: (def: FieldDef) => void }) {
  const [picking, setPicking] = useState<{ value: string; anchor: HTMLElement } | null>(null)
  const [naming, setNaming] = useState('')
  const open = def.type !== 'enum' && def.type !== 'boolean'
  const values = def.type === 'enum' ? (def.values ?? []) : def.type === 'boolean' ? ['true', 'false'] : Object.keys(def.colors ?? {})
  const set = (value: string, color: ValueColor | null) => {
    const { [value]: _old, ...rest } = def.colors ?? {}
    const colors = color ? { ...rest, [value]: color } : rest
    onChange({ ...def, colors: Object.keys(colors).length ? colors : undefined })
    setPicking(null)
  }
  return (
    <div className="md:col-span-2">
      <Kicker>Colours</Kicker>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <button key={v} type="button" title={def.colors?.[v] ? `${def.colors[v]}: click to change` : 'Its own colour: click to pick one'} onClick={(ev) => setPicking({ value: v, anchor: ev.currentTarget })}>
            <Chip value={v} label={def.type === 'boolean' ? (v === 'true' ? 'yes' : 'no') : v} def={def} />
          </button>
        ))}
        {open && (
          <input
            className={`${input} w-40 font-mono text-[12px]`}
            placeholder="name a value, press enter"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !naming.trim()) return
              e.preventDefault()
              setPicking({ value: naming.trim(), anchor: e.currentTarget })
              setNaming('')
            }}
          />
        )}
        {!values.length && !open && <span className="font-mono text-[10px] text-ink-500">Give the field its values first.</span>}
      </div>
      {picking && (
        <Popover anchor={picking.anchor} onClose={() => setPicking(null)} className="p-2">
          <div className="grid grid-cols-6 gap-1.5">
            {VALUE_COLORS.map((c) => (
              <button key={c} type="button" title={c} onClick={() => set(picking.value, c)} className={`size-5 rounded-full ${def.colors?.[picking.value] === c ? 'ring-2 ring-ink-100 ring-offset-2 ring-offset-ink-850' : 'hover:ring-1 hover:ring-ink-300'}`} style={{ background: swatch(c) }} />
            ))}
          </div>
          {def.colors?.[picking.value] && (
            <div className="mt-2 border-t border-ink-700 pt-1">
              <MenuItem onClick={() => set(picking.value, null)}>
                <span className="font-mono text-[12px] text-ink-400">{open ? 'Forget this value' : 'Its own colour'}</span>
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
    </div>
  )
}
