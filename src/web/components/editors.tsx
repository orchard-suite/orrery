// Editing in place. Every value a person may change is changed where it is
// shown, through one of these: a click opens the editor on the value, Enter
// or a click elsewhere keeps the change, Escape drops it.

import { Check, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { EntityPatch } from '../../shared/api.ts'
import { currencyOf, currencyText, parseCurrency } from '../../shared/currency.ts'
import { AZURE_ICONS, BRAND_ICONS, CONCEPT_ICONS, linksOf } from '../../shared/icons.ts'
import { entityId, isDerived, type Entity, type EntityRef, type FieldDef, type Layer, type RelatedRef } from '../../shared/model.ts'
import { useBlueprintName, useBlueprints, useCustomIcons, useEntitySearch, usePickPicture, useWhoAmI } from '../api.ts'
import { Icon } from '../icons.tsx'
import { readSpec } from '../spec.ts'
import { MenuItem, Popover, walk } from './Popover.tsx'
import { Chip, Kicker } from './ui.tsx'

export const TITLE_DEF: FieldDef = { type: 'string', title: 'Title' }

/** Why a person cannot change a field's value here, or null when they can. */
export function fieldLock(def: FieldDef | undefined, layer: Layer | undefined, admin = false): string | null {
  if (!def) return 'Not a field of the blueprint'
  if (def.adminEdit && !admin) return 'Only an admin changes this field'
  if (def.pivoted) return `A property of ${def.pivoted.field}: change it there`
  if (isDerived(def)) return 'Derived: computed from other values'
  if (layer === 'git') return 'Set in git: change it there'
  if (def.overridable === false) return 'Locked: only sources write this field'
  return null
}

/** The patch that points a relation at these targets. None clears what a person set. */
export function relationPatch(name: string, many: boolean, targets: EntityRef[]): EntityPatch {
  const ids = targets.map(entityId)
  return { relations: { [name]: ids.length === 0 ? null : many ? ids : ids[0]! } }
}

// Icons ------------------------------------------------------------------------

const ICON_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Concepts', CONCEPT_ICONS],
  ['Brands', BRAND_ICONS],
  ['Azure', AZURE_ICONS],
]

/** Every icon in the set and every custom icon the hub holds, searchable. `resets` offer the ways back to whatever the icon was before a person chose one. */
/**
 * Picks an icon from the set and the custom icons. A person's photo is never
 * among them: only `photo`, the reader's own when they pick their own
 * picture, is offered, first, as "Your photo".
 */
export function IconPicker({ anchor, value, onPick, resets = [], onClose, photo = null }: { anchor: HTMLElement; value: string | null | undefined; onPick: (name: string) => void; resets?: { label: string; run: () => void }[]; onClose: () => void; photo?: string | null }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_')
  const custom = [...(useCustomIcons().data?.keys() ?? [])]
  const groups: (readonly [string, readonly string[]])[] = [...(photo && (!needle || 'your_photo'.includes(needle)) ? [['Your photo', [photo]] as const] : []), ...(custom.length ? [['Custom', custom] as const] : []), ...ICON_GROUPS]
  return (
    <Popover anchor={anchor} onClose={onClose} label="Choose an icon" className="w-[26rem] p-2">
      <input className="w-full rounded-sm border border-edge bg-ink-900 px-2 py-1 text-sm text-ink-100 focus:border-ink-300" aria-label="Search icons" placeholder="Search icons" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <div className="mt-1 max-h-96 overflow-y-auto">
        {groups.map(([label, names]) => {
          const shown = names.filter((n) => n === photo || n.includes(needle))
          if (!shown.length) return null
          return (
            <div key={label}>
              <Kicker className="mt-2 mb-1">{label}</Kicker>
              <div className="grid grid-cols-8 gap-1">
                {shown.map((n) => (
                  <button type="button" key={n} title={n === photo ? 'Your photo' : n} aria-pressed={n === value} onClick={() => onPick(n)} className={`flex aspect-square items-center justify-center rounded-sm hover:bg-ink-700 hover:text-ink-100 ${n === value ? 'bg-ink-700 text-ink-100' : 'text-ink-300'}`}>
                    <Icon name={n} className="size-6" />
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {resets.map((reset) => (
        <button type="button" key={reset.label} onClick={reset.run} className="btn btn-ghost mt-2 w-full">
          {reset.label}
        </button>
      ))}
    </Popover>
  )
}

/**
 * An entity's icon. Whoever may edit clicks it to pick another, and the
 * choice is the entity's own from then on. `layer` is where the icon shown
 * came from: a default is the blueprint's, anything else has a way back.
 */
export function EntityIcon({ e, layer, canEdit, onEdit, className = 'size-3.5', large = false }: { e: Pick<Entity, 'icon' | 'picture' | 'blueprint' | 'key'>; layer: Layer | undefined; canEdit: boolean; onEdit: (patch: EntityPatch) => void; className?: string; large?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const me = useWhoAmI().data
  const mine = !!me?.person?.entity && !me.identity.viewAs && me.person.entity.blueprint === e.blueprint && me.person.entity.key === e.key
  if (mine) return <OwnPicture e={e} className={className} large={large} />
  if (!canEdit || layer === 'git' || e.picture) {
    return (
      <span className="shrink-0 text-ink-400" title={!canEdit ? undefined : e.picture === 'photo' ? 'Their photo: only they change their picture' : e.picture === 'picked' ? 'Their own pick: only they change their picture' : 'This icon is set in git'}>
        <Icon name={e.icon} className={className} large={large} />
      </span>
    )
  }
  const own = !!layer && layer !== 'default'
  const close = () => setAnchor(null)
  return (
    <>
      <button type="button" className="-m-0.5 shrink-0 rounded-sm p-0.5 text-ink-400 max-md:-m-1.5 max-md:p-1.5 hover:bg-ink-700 hover:text-ink-100" title="Change the icon" onClick={(event) => setAnchor(event.currentTarget)}>
        <Icon name={e.icon} className={className} />
      </button>
      {anchor && (
        <IconPicker
          anchor={anchor}
          value={e.icon}
          onPick={(name) => (onEdit({ fields: { icon: name } }), close())}
          resets={own ? [{ label: layer === 'override' ? 'Back to the pushed icon' : "Back to the blueprint's icon", run: () => (onEdit({ fields: { icon: null } }), close()) }] : []}
          onClose={close}
        />
      )}
    </>
  )
}

/**
 * A person's own picture on their own entity: theirs to pick from the icons,
 * or their photo, whatever else they may change. Everyone sees what they pick.
 */
function OwnPicture({ e, className, large }: { e: Pick<Entity, 'icon'>; className: string; large: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const me = useWhoAmI().data?.person
  const pick = usePickPicture()
  const close = () => setAnchor(null)
  const choose = (icon: string | null) => (pick.mutate(icon), close())
  return (
    <>
      <button type="button" className={`-m-0.5 shrink-0 p-0.5 text-ink-400 max-md:-m-1.5 max-md:p-1.5 hover:bg-ink-700 hover:text-ink-100 ${large ? 'rounded-full' : 'rounded-sm'}`} title="Change your picture" onClick={(event) => setAnchor(event.currentTarget)}>
        <Icon name={e.icon} className={className} large={large} />
      </button>
      {anchor && (
        <IconPicker
          anchor={anchor}
          value={e.icon}
          photo={me?.photo ?? null}
          onPick={(name) => choose(name === me?.photo ? null : name)}
          resets={me?.pick ? [{ label: me.photo ? 'Back to your photo' : 'Back to your usual icon', run: () => choose(null) }] : []}
          onClose={close}
        />
      )}
    </>
  )
}

// Field values -------------------------------------------------------------------

const BLOCK_TYPES: readonly FieldDef['type'][] = ['markdown', 'object', 'array', 'healthcheck', 'openapi']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** A stored datetime as the local time a `datetime-local` input shows. */
function localTime(value: unknown): string {
  const d = typeof value === 'string' ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function asText(value: unknown, def: FieldDef | undefined): string {
  if (value === null || value === undefined) return ''
  if (def?.type === 'datetime') return localTime(value)
  const money = currencyOf(def)
  if (money && typeof value === 'number') return currencyText(value, money)
  if (def?.type === 'url' && def.many) return linksOf(value).join('\n')
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** What was typed, as the value the field stores. Nothing typed is null: it clears what a person set. */
function parse(text: string, def: FieldDef | undefined): { value: unknown } | { error: string } {
  const t = text.trim()
  if (t === '') return { value: null }
  if (def?.type === 'url' && def.many) {
    const links = t.split(/\s+/).filter(Boolean)
    const bad = links.find((l) => !URL.canParse(l))
    return bad ? { error: `"${bad}" is not a link. Put one link on each line` } : { value: links }
  }
  switch (def?.type) {
    case 'number': {
      const money = currencyOf(def)
      if (money) return parseCurrency(t, money)
      const n = Number(t)
      return Number.isFinite(n) ? { value: n } : { error: 'Not a number' }
    }
    case 'datetime': {
      const d = new Date(t)
      return Number.isNaN(d.getTime()) ? { error: 'Not a date and time' } : { value: d.toISOString() }
    }
    case 'object':
    case 'array':
    case 'healthcheck':
    case 'openapi':
      if (def.type === 'openapi' && /^https?:\/\//.test(t)) return URL.canParse(t) ? { value: t } : { error: 'Not a link' }
      try {
        return { value: JSON.parse(t) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Not JSON' }
      }
    case 'markdown':
      return { value: text }
    default:
      return { value: t }
  }
}

/**
 * Changes one field's value where it stands. A choice (enum, boolean) is a
 * menu; a short value is a line that covers the cell; long text and JSON get
 * a block. `place` is `below` when the anchor is a control rather than the
 * value itself.
 */
export function ValueEditor({ anchor, place = 'over', def, value, onCommit, onClose, textClass = 'text-sm' }: { anchor: HTMLElement; place?: 'over' | 'below'; def: FieldDef | undefined; value: unknown; onCommit: (value: unknown) => void; onClose: () => void; textClass?: string }) {
  const initial = useRef(asText(value, def)).current
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  if (def?.type === 'enum' && def.many) return <ListEditor anchor={anchor} def={def} value={value} onCommit={onCommit} onClose={onClose} />
  if (def?.type === 'enum' || def?.type === 'boolean') {
    const options: { value: unknown; label: string }[] = def.type === 'boolean' ? [{ value: true, label: 'yes' }, { value: false, label: 'no' }] : (def.values ?? []).map((v) => ({ value: v, label: v }))
    const shown = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    const pick = (next: unknown) => (next === (value ?? null) ? onClose() : onCommit(next))
    const searchable = options.length > 8
    return (
      <Popover anchor={anchor} onClose={onClose} width={160} label={def.title ?? 'Value'} className="py-1">
        <div onKeyDown={(e) => walk(e)} className="max-h-72 overflow-y-auto">
          {searchable && (
            <div className="px-2 pb-1">
              <input className="w-full rounded-sm border border-edge bg-ink-900 px-2 py-1 text-sm focus:border-ink-300" aria-label="Find a value" placeholder="Find" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shown.length === 1 && pick(shown[0]!.value)} autoFocus />
            </div>
          )}
          <div role="menu" aria-label={def.title ?? 'Value'}>
          {shown.map((o, i) => (
            <MenuItem key={o.label} check="radio" onClick={() => pick(o.value)} active={o.value === value} autoFocus={!searchable && i === 0}>
              <Chip value={String(o.value)} label={o.label} def={def} />
              {o.value === value && <Check className="ml-auto size-3.5 text-ink-300" />}
            </MenuItem>
          ))}
          {value !== null && value !== undefined && (
            <MenuItem onClick={() => pick(null)}>
              <span className="text-[13px] text-ink-400">Clear</span>
            </MenuItem>
          )}
          </div>
        </div>
      </Popover>
    )
  }

  const commit = () => {
    if (text === initial) return onClose()
    const parsed = parse(text, def)
    if ('error' in parsed) return setError(parsed.error)
    onCommit(parsed.value)
  }
  const errorId = useId()
  const block = !!def && (BLOCK_TYPES.includes(def.type) || (def.type === 'url' && !!def.many))
  return (
    <Popover anchor={anchor} place={place} width={block ? 460 : 220} onClose={onClose} onOutside={commit} label={def?.title ?? 'Value'} className="border-orbit">
      {block ? (
        <>
          <textarea
            className="block min-h-40 w-full resize-y bg-transparent px-2 py-1.5 font-mono text-[12px] text-ink-100 outline-none"
            value={text}
            onChange={(e) => (setText(e.target.value), setError(null))}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && commit()}
            aria-label={def?.title ?? 'Value'}
            aria-invalid={!!error || undefined}
            aria-errormessage={error ? errorId : undefined}
            spellCheck={def?.type === 'markdown'}
            autoFocus
          />
          <div className="flex items-center gap-2 border-t border-ink-700 px-2 py-1 font-mono text-[10px] text-ink-400">
            <span>{def?.type === 'markdown' ? 'markdown' : def?.type === 'openapi' ? 'JSON, or a link' : 'JSON'} · ⌘↵ keeps it · esc drops it</span>
            {def?.type === 'openapi' && (
              <label className="btn btn-ghost cursor-pointer px-2 py-0.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-orbit hover:border-ink-300" title="An OpenAPI or Swagger document, as JSON or YAML">
                Load a file
                <input
                  type="file"
                  accept=".json,.yaml,.yml,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) readSpec(file).then((doc) => (setText(JSON.stringify(doc, null, 2)), setError(null)), (reason: Error) => setError(reason.message))
                  }}
                />
              </label>
            )}
            <button type="button" className="btn btn-solid ml-auto px-2 py-0.5" onClick={commit}>
              Keep
            </button>
          </div>
        </>
      ) : (
        <input
          className={`block w-full bg-transparent px-2 py-1 text-ink-100 outline-none ${textClass}`}
          style={{ minHeight: place === 'over' ? anchor.offsetHeight - 2 : undefined }}
          type={def?.type === 'datetime' ? 'datetime-local' : 'text'}
          inputMode={def?.type === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(e) => (setText(e.target.value), setError(null))}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-label={def?.title ?? 'Value'}
          aria-invalid={!!error || undefined}
          aria-errormessage={error ? errorId : undefined}
          onFocus={(e) => def?.type !== 'datetime' && e.target.select()}
          autoFocus
        />
      )}
      {error && <div id={errorId} role="alert" className="border-t border-red-dim px-2 py-1 text-[12px] text-red">{error}</div>}
    </Popover>
  )
}

/** Picks several of a list field's values at once. A click elsewhere keeps the set; nothing picked clears what a person set. */
function ListEditor({ anchor, def, value, onCommit, onClose }: { anchor: HTMLElement; def: FieldDef; value: unknown; onCommit: (value: unknown) => void; onClose: () => void }) {
  const initial = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  const [picked, setPicked] = useState<string[]>(initial)
  const [filter, setFilter] = useState('')
  const options = (def.values ?? []).filter((v) => v.toLowerCase().includes(filter.toLowerCase()))
  const same = picked.length === initial.length && picked.every((p) => initial.includes(p))
  const done = () => (same ? onClose() : onCommit(picked.length ? (def.values ?? []).filter((v) => picked.includes(v)) : null))
  const toggle = (v: string) => setPicked(picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v])
  return (
    <Popover anchor={anchor} onClose={onClose} onOutside={done} width={200} label={def.title ?? 'Values'} className="py-1">
      <div onKeyDown={(e) => walk(e)} className="max-h-72 overflow-y-auto">
        {(def.values ?? []).length > 8 && (
          <div className="px-2 pb-1">
            <input className="w-full rounded-sm border border-edge bg-ink-900 px-2 py-1 text-sm focus:border-ink-300" aria-label="Find a value" placeholder="Find" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (options.length === 1 ? toggle(options[0]!) : done())} autoFocus />
          </div>
        )}
        <div role="menu" aria-label={def.title ?? 'Values'}>
        {options.map((v, i) => (
          <MenuItem key={v} check="checkbox" onClick={() => toggle(v)} active={picked.includes(v)} autoFocus={(def.values ?? []).length <= 8 && i === 0}>
            <Chip value={v} def={def} />
            {picked.includes(v) && <Check className="ml-auto size-3.5 text-ink-300" />}
          </MenuItem>
        ))}
        {picked.length > 0 && (
          <MenuItem onClick={() => (setPicked([]), onCommit(null))}>
            <span className="text-[13px] text-ink-400">Clear</span>
          </MenuItem>
        )}
        </div>
      </div>
    </Popover>
  )
}

// Relations ---------------------------------------------------------------------

const sameTargets = (a: EntityRef[], b: EntityRef[]) => a.length === b.length && a.every((x) => b.some((y) => y.key === x.key))

/**
 * Points a relation at entities of its target blueprint, found by typing. A
 * to-one relation is set by the first choice; a to-many keeps choosing until
 * a click elsewhere. A key that is not in the catalog yet may still be
 * pointed at: the relation connects when the entity arrives.
 */
export function RelationEditor({ anchor, place = 'over', target, many, value, onCommit, onClose }: { anchor: HTMLElement; place?: 'over' | 'below'; target: string; many: boolean; value: RelatedRef[]; onCommit: (targets: EntityRef[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<RelatedRef[]>(value)
  const found = useEntitySearch(target, query.trim())
  const title = useBlueprintName()(target)
  const results = found.data?.entities ?? []
  const has = (ref: EntityRef) => picked.some((p) => p.key === ref.key)
  const done = (next: EntityRef[]) => (sameTargets(next, value) ? onClose() : onCommit(next))
  const choose = (ref: RelatedRef) => {
    const next = { blueprint: target, key: ref.key, title: ref.title }
    if (!many) return done([next])
    setPicked(has(next) ? picked.filter((p) => p.key !== next.key) : [...picked, next])
  }
  const typed = query.trim()
  const pending = typed && !results.some((r) => r.key === typed) ? typed : null
  return (
    <Popover anchor={anchor} place={place} width={320} onClose={onClose} onOutside={() => (many ? done(picked) : onClose())} label={`Point at a ${title.toLowerCase()}`} className="border-orbit">
      <div onKeyDown={(e) => walk(e)}>
        <input className="block w-full bg-transparent px-2 py-1.5 text-sm text-ink-100 outline-none" aria-label={`Find a ${title.toLowerCase()}`} placeholder={`Find a ${title.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (results.length === 1 ? choose(results[0]!) : many && done(picked))} autoFocus />
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-ink-700 px-2 py-1.5">
            {picked.map((p) => (
              <span key={p.key} className="inline-flex max-w-full items-center gap-1 rounded-sm border border-ink-600 py-px pr-0.5 pl-1.5 text-[12px] text-ink-200" title={p.key}>
                <span className="truncate">{p.title ?? p.key}</span>
                <button type="button" title="Remove" aria-label={`Remove ${p.title ?? p.key}`} className="rounded-sm text-ink-400 hover:bg-ink-700 hover:text-ink-100 max-md:-my-2 max-md:p-3" onClick={() => (many ? setPicked(picked.filter((x) => x.key !== p.key)) : done([]))}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div role="menu" aria-label={title} className="max-h-64 overflow-y-auto border-t border-ink-700 py-1">
          {results.map((r) => (
            <MenuItem key={r.key} check={many ? 'checkbox' : 'radio'} onClick={() => choose(r)} active={has(r)}>
              <Icon name={r.icon} className="size-3.5 shrink-0 text-ink-400" />
              <span className="truncate">{r.title}</span>
              {r.title !== r.key && <span className="truncate font-mono text-[10px] text-ink-500">{r.key}</span>}
              {has(r) && <Check className="ml-auto size-3.5 shrink-0 text-ink-300" />}
            </MenuItem>
          ))}
          {pending && (
            <MenuItem onClick={() => choose({ blueprint: target, key: pending })}>
              <span className="truncate">
                Point at <span className="font-mono text-[12px]">{pending}</span>
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-500">not in the catalog yet</span>
            </MenuItem>
          )}
          {found.data && results.length === 0 && !pending && <div className="px-3 py-1 text-sm text-ink-400">No {title.toLowerCase()} yet.</div>}
        </div>
      </div>
    </Popover>
  )
}
