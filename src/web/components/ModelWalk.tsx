// The model on a phone. A graph of every blueprint cannot be read at that
// size, so the phone walks it instead: one blueprint fills the screen, with
// what it is joined to in a ring around it, and a tap on a neighbour walks
// there. The trail of the walk stays at the top.
//
// Below the ring the blueprint reads as sentences, and the sentences are the
// editor: a blue part is a name, an orange part is what it holds or where its
// value comes from, and a tap on either opens the one thing it says. A
// sentence at the end adds a property or a relation. Every change saves at
// once, through the same forms the model page uses. What a person may not
// change reads the same, with nothing to tap, and says why.

import { ArrowRight, ChevronRight, Import, Lock, Plus, Search, Settings2, Workflow } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { AGGREGATION_FNS, type AggregationDef, type Blueprint, type FieldType } from '../../shared/model.ts'
import { useBlueprintName, useBlueprints, useCan, useIsAdmin, useSaveBlueprint } from '../api.ts'
import { BlueprintIcon } from '../icons.tsx'
import { DISCARD } from '../layers.ts'
import { words as said } from '../format.ts'
import { navigate } from '../router.ts'
import { aggregationWords, fieldWords, KINDS, kindWords, nameFor, reachesFrom, reachOf } from '../sentences.ts'
import { BlueprintEditor, ImportPanel, lockOf, RelationPopover } from './BlueprintEditor.tsx'
import { AlertRulesPanel, RulesPanel } from './Blueprints.tsx'
import { BlueprintIndex, entities } from './BlueprintIndex.tsx'
import { Drawer } from './Drawer.tsx'
import { FieldPopover, specOf, withType } from './FieldForm.tsx'
import { Orbit, type OrbitNode } from './Orbit.tsx'
import { Popover } from './Popover.tsx'
import { Button, ErrorNote, input, Link } from './ui.tsx'
import { useVisit } from '../trail.ts'

/** One way two blueprints are joined: a relation, and which way it points. */
interface Join {
  name: string
  title: string
  other: string
  direction: 'out' | 'in'
  many: boolean
}

/** Every relation that leaves a blueprint and every one that reaches it. */
export function joinsOf(bp: Blueprint, all: Blueprint[]): Join[] {
  const out = Object.entries(bp.relations).map(([name, r]): Join => ({ name, title: r.title ?? name, other: r.target, direction: 'out', many: !!r.many }))
  const into = all.flatMap((o) => Object.entries(o.relations).filter(([, r]) => r.target === bp.id).map(([name, r]): Join => ({ name, title: r.inverseTitle ?? r.title ?? name, other: o.id, direction: 'in', many: !!r.many })))
  return [...out, ...into]
}

const TRAIL = 'orrery.walk'

/** The blueprints walked through to reach this one. Walking back to one on the trail cuts it there. */
function useTrail(id: string | null): string[] {
  return useMemo(() => {
    let was: string[] = []
    try {
      was = JSON.parse(sessionStorage.getItem(TRAIL) ?? '[]')
    } catch {
      // A browser that keeps nothing walks without a trail behind it.
    }
    const at = id ? was.indexOf(id) : -1
    const next = !id ? [] : at >= 0 ? was.slice(0, at + 1) : [...was, id].slice(-8)
    try {
      sessionStorage.setItem(TRAIL, JSON.stringify(next))
    } catch {
      // As above.
    }
    return next
  }, [id])
}

/** What is open over the page: one part of a sentence, or a drawer. */
type Open =
  | { what: 'field'; name: string | null; anchor: HTMLElement }
  | { what: 'kind'; name: string; anchor: HTMLElement }
  | { what: 'count'; name: string; anchor: HTMLElement }
  | { what: 'relation'; bp: string; name: string; anchor: HTMLElement }
  | { what: 'details' | 'new' | 'import' | 'rules' }

/** Above this many properties, a blueprint offers a box to find one. */
const FIND_FROM = 12

export function ModelWalk({ id }: { id: string | null }) {
  const blueprints = useBlueprints()
  const all = blueprints.data?.blueprints ?? []
  const counts = blueprints.data?.counts ?? {}
  const trail = useTrail(id)
  const name = useBlueprintName()
  const canAuthor = useCan('model.edit')
  const admin = useIsAdmin()
  const adminOnly = blueprints.data?.adminOnly ?? []
  const [open, setOpen] = useState<Open | null>(null)
  const [find, setFind] = useVisit('walk.find', '')
  const close = () => setOpen(null)
  const bp = all.find((b) => b.id === id)
  if (blueprints.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const locked = (b: Blueprint) => lockOf(b, canAuthor, !admin && adminOnly.includes(b.id))
  const drawers = <Drawers open={open} bp={bp ?? null} all={all} count={bp ? (counts[bp.id] ?? 0) : 0} canAuthor={canAuthor} onClose={close} />
  if (!bp) {
    return (
      <>
        <BlueprintIndex
          title="Model"
          intro="Pick a blueprint to read what it holds and what it is joined to, and to change it. Tap a neighbour to walk there."
          all={all}
          counts={counts}
          to={(to) => ({ page: 'model', id: to })}
          details={(b) => `${entities(counts[b.id] ?? 0)} · ${Object.keys(b.fields).length} properties · ${Object.keys(b.relations).length} relations`}
          actions={
            <div className="flex flex-wrap gap-2">
              {canAuthor && (
                <>
                  <Button kind="solid" opens="dialog" onClick={() => setOpen({ what: 'new' })}>
                    <Plus className="size-4" aria-hidden /> New blueprint
                  </Button>
                  <Button opens="dialog" onClick={() => setOpen({ what: 'import' })}>
                    <Import className="size-4" aria-hidden /> Import
                  </Button>
                </>
              )}
              <Button opens="dialog" onClick={() => setOpen({ what: 'rules' })}>
                <Workflow className="size-4" aria-hidden /> Rules
              </Button>
            </div>
          }
        />
        {drawers}
      </>
    )
  }
  const byId = new Map(all.map((b) => [b.id, b]))
  const joins = joinsOf(bp, all)
  const walk = (to: string) => navigate({ page: 'model', id: to })
  // One place on the ring for each neighbour, however many relations join the two; a blueprint joined to itself is in the sentences below, not the ring.
  const ring = new Map<string, OrbitNode>()
  for (const j of joins) {
    if (j.other === bp.id) continue
    const other = byId.get(j.other)
    const was = ring.get(j.other)
    if (was) was.caption += `, ${j.title}`
    else ring.set(j.other, { id: j.other, title: name(other ?? j.other), icon: <BlueprintIcon bp={other} className="size-5" />, caption: j.title, direction: j.direction, onPick: () => walk(j.other) })
  }
  const why = locked(bp)
  const tap = why ? undefined : (o: Open) => setOpen(o)
  const words = find.trim().toLowerCase()
  const fields = Object.entries(bp.fields).filter(([key, def]) => !words || key.includes(words) || (def.title ?? '').toLowerCase().includes(words))
  const total = Object.keys(bp.fields).length
  const incoming = all.flatMap((o) => Object.entries(o.relations).filter(([, r]) => r.target === bp.id).map(([rel, r]) => ({ from: o, rel, def: r })))
  return (
    <div className="space-y-5 pt-2 pb-6">
      <nav aria-label="Your walk" className="-mx-3 flex items-center gap-1 overflow-x-auto px-3 text-[13px] whitespace-nowrap">
        <Link to={{ page: 'model', id: null }} className="rounded-full px-2 py-1 text-ink-400">
          All
        </Link>
        {trail.map((t) => (
          <span key={t} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0 text-ink-500" aria-hidden />
            <Link to={{ page: 'model', id: t }} current={t === bp.id} className={`rounded-full px-2 py-1 ${t === bp.id ? 'bg-ink-800 font-medium text-ink-100' : 'text-ink-400'}`}>
              {name(byId.get(t) ?? t)}
            </Link>
          </span>
        ))}
      </nav>
      <h1 className="sr-only">{name(bp)}</h1>
      <Orbit title={name(bp)} icon={<BlueprintIcon bp={bp} className="size-7" />} nodes={[...ring.values()]} />

      <section aria-label="What it is" className="space-y-3">
        <p className="text-[17px] leading-8 text-ink-200">
          <Tap label={`Change ${name(bp)}: its title, description, icon, group, lifecycle, and who sees it`} onTap={tap && (() => tap({ what: 'details' }))}>
            {name(bp)}
          </Tap>
          {bp.description ? ': ' : '.'}
          {bp.description && (
            <Tap label={`Change what ${name(bp)} says it is`} onTap={tap && (() => tap({ what: 'details' }))} quiet>
              {bp.description.trim()}
            </Tap>
          )}
        </p>
        {why && (
          <p className="flex items-start gap-2 text-[13px] text-ink-300">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-400" aria-hidden />
            <span>Read only here: {why}.</span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Link to={{ page: 'inventory', blueprint: bp.id }} className="btn btn-solid flex-1 py-2.5">
            Browse {entities(counts[bp.id] ?? 0)} <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Button opens="dialog" className="py-2.5" onClick={() => setOpen({ what: 'details' })}>
            <Settings2 className="size-4" aria-hidden /> {why ? 'Details' : 'Lifecycle, access, YAML'}
          </Button>
        </div>
      </section>

      <Sentences title="Each one holds" count={total + 1}>
        {total >= FIND_FROM && (
          <li className="list-none py-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
              <input type="search" className={`${input} w-full py-2.5 pl-9 text-base`} aria-label={`Find among ${total} properties`} placeholder={`Find among ${total}`} value={find} onChange={(e) => setFind(e.target.value)} />
            </div>
          </li>
        )}
        {!words && (
          <Sentence>
            <span className="font-medium text-ink-100">Title</span>, text. <span className="text-ink-400">Every entity has one.</span>
          </Sentence>
        )}
        {fields.map(([key, def]) => {
          const derived = !!(def.aggregation || def.mirror || def.pivoted || def.calculation !== undefined || def.derived)
          const counting = !!def.aggregation && !!reachOf(def.aggregation.relation, bp, all, name)
          return (
            <Sentence key={key} note={def.description}>
              <Tap label={`Change ${def.title ?? said(key)}`} onTap={tap && ((anchor) => tap({ what: 'field', name: key, anchor }))}>
                {def.title ?? said(key)}
              </Tap>
              {', '}
              <Tap kind label={derived ? `Change how ${def.title ?? said(key)} is worked out` : `Change what ${def.title ?? said(key)} holds`} onTap={tap && ((anchor) => tap(counting ? { what: 'count', name: key, anchor } : derived ? { what: 'field', name: key, anchor } : { what: 'kind', name: key, anchor }))}>
                {fieldWords(def, bp, all, name)}
              </Tap>
              .
            </Sentence>
          )
        })}
        {words && !fields.length && <li className="list-none py-3 text-sm text-ink-400">No property is called that.</li>}
      </Sentences>

      <Sentences title="It points at" count={Object.keys(bp.relations).length}>
        {Object.entries(bp.relations).map(([rel, r]) => (
          <Sentence key={rel} note={r.description}>
            Points at {r.many ? 'many' : 'one'} <Walk to={byId.get(r.target)} id={r.target} /> as{' '}
            <Tap label={`Change the relation ${r.title ?? said(rel)}`} onTap={tap && ((anchor) => tap({ what: 'relation', bp: bp.id, name: rel, anchor }))}>
              {r.title ?? said(rel)}
            </Tap>
            {r.required ? ', always' : ''}
            {r.display === 'contain' ? ', and lives inside it' : ''}.
          </Sentence>
        ))}
      </Sentences>

      <Sentences title="Others point at it" count={incoming.length}>
        {incoming.map(({ from, rel, def }) => {
          const theirs = locked(from)
          return (
            <Sentence key={`${from.id}:${rel}`} note={theirs ? undefined : def.inverseTitle ? `Seen here as ${def.inverseTitle}.` : undefined}>
              Each <Walk to={from} id={from.id} /> points at {def.many ? 'many of these' : 'one of these'} as{' '}
              <Tap label={`Change the relation ${def.title ?? said(rel)} on ${name(from)}`} onTap={theirs ? undefined : (anchor) => setOpen({ what: 'relation', bp: from.id, name: rel, anchor })}>
                {def.title ?? said(rel)}
              </Tap>
              .
            </Sentence>
          )
        })}
      </Sentences>

      {!why && <Composer key={bp.id} bp={bp} all={all} />}

      {open && 'anchor' in open && <Sheet open={open} bp={bp} all={all} onClose={close} onMore={(name, anchor) => setOpen({ what: 'field', name, anchor })} />}
      {drawers}
    </div>
  )
}

/** A titled list of sentences. It is left out while it holds none. */
function Sentences({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null
  return (
    <section>
      <h2 className="mb-1 px-1 text-[13px] font-semibold text-ink-300">
        {title} <span className="font-normal text-ink-500">· {count}</span>
      </h2>
      <ul className="divide-y divide-ink-800">{children}</ul>
    </section>
  )
}

/** One sentence, with what it is for under it. */
function Sentence({ note, children }: { note?: string; children: ReactNode }) {
  return (
    <li className="px-1 py-2.5 text-base leading-9 text-ink-200">
      {children}
      {note && <span className="mt-1 block text-[13px] leading-5 text-ink-400">{note}</span>}
    </li>
  )
}

/**
 * A part of a sentence a person taps to change. A name is blue; a `kind`, what
 * a field holds or where its value comes from, is orange. It runs with the
 * sentence's words, wrapping where they wrap, so it is a button by its role
 * and its keys rather than a button element, which would set the words in a
 * box of their own. Its hit area is taller than the words and stays inside
 * its line. Without `onTap` it reads the same with nothing to tap.
 */
function Tap({ kind = false, quiet = false, label, onTap, children }: { kind?: boolean; quiet?: boolean; label: string; onTap?: (anchor: HTMLElement) => void; children: ReactNode }) {
  if (!onTap) return <span className={kind || quiet ? '' : 'font-medium text-ink-100'}>{children}</span>
  const look = kind ? 'text-edit decoration-edit/60' : quiet ? 'text-ink-200 decoration-ink-500' : 'font-medium text-orbit decoration-orbit/60'
  return (
    <span
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={label}
      onClick={(e) => onTap(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onTap(e.currentTarget)
      }}
      className={`-my-1 cursor-pointer py-1 underline decoration-dashed decoration-[1.5px] underline-offset-[5px] ${look}`}
    >
      {children}
    </span>
  )
}

/** A blueprint named in a sentence, which walks there. */
function Walk({ to, id }: { to: Blueprint | undefined; id: string }) {
  const name = useBlueprintName()
  return (
    <Link to={{ page: 'model', id }} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-orbit/10 px-2.5 align-baseline text-[15px] leading-7 font-medium text-orbit">
      <BlueprintIcon bp={to} className="size-3.5 shrink-0" />
      <span className="truncate">{name(to ?? id)}</span>
    </Link>
  )
}

/** The sheet one tapped part of a sentence opens. */
function Sheet({ open, bp, all, onClose, onMore }: { open: Extract<Open, { anchor: HTMLElement }>; bp: Blueprint; all: Blueprint[]; onClose: () => void; onMore: (name: string, anchor: HTMLElement) => void }) {
  if (open.what === 'field') return <FieldPopover bp={bp} name={open.name} anchor={open.anchor} onClose={onClose} />
  if (open.what === 'kind') return <KindSheet bp={bp} name={open.name} anchor={open.anchor} onClose={onClose} />
  if (open.what === 'count') return <CountSheet bp={bp} all={all} name={open.name} anchor={open.anchor} onClose={onClose} onMore={() => onMore(open.name, open.anchor)} />
  const owner = all.find((b) => b.id === open.bp)
  if (!owner) return null
  return <RelationPopover bp={owner} all={all} name={open.name} target={owner.relations[open.name]?.target ?? bp.id} anchor={open.anchor} onClose={onClose} />
}

/** What a field holds, as one choice in words. A pick saves at once. */
function KindSheet({ bp, name, anchor, onClose }: { bp: Blueprint; name: string; anchor: HTMLElement; onClose: () => void }) {
  const save = useSaveBlueprint()
  const def = bp.fields[name]
  if (!def) return null
  const title = def.title ?? said(name)
  const pick = (type: FieldType) => (type === def.type ? onClose() : save.mutate({ id: bp.id, spec: { ...specOf(bp), fields: { ...bp.fields, [name]: withType(def, type) } } }, { onSuccess: onClose }))
  return (
    <Popover anchor={anchor} width={380} onClose={onClose} label={`What ${title} holds`} className="max-h-[80vh] overflow-y-auto p-4">
      <h2 className="text-[17px] font-semibold text-ink-100">{title} holds…</h2>
      <p className="mt-1 text-[13px] text-ink-400">Values already kept stay as they are. A pick saves at once.</p>
      <ul className="mt-3 divide-y divide-ink-800">
        {KINDS.map((k) => (
          <li key={k.type}>
            <button type="button" aria-pressed={k.type === def.type} disabled={save.isPending} onClick={() => pick(k.type)} className="flex w-full items-start gap-3 py-3 text-left">
              <span className={`mt-1 size-4 shrink-0 rounded-full border-2 ${k.type === def.type ? 'border-orbit bg-orbit shadow-[inset_0_0_0_2px_var(--color-ink-850)]' : 'border-ink-500'}`} aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-ink-100">{k.words}</span>
                <span className="block text-[13px] text-ink-400">{k.meaning}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={save.error} />
      <p className="mt-2 text-[13px] text-ink-400">Now {kindWords(def)}.</p>
    </Popover>
  )
}

const FN_TITLES: Record<AggregationDef['fn'], string> = { count: 'Count them', sum: 'Add up a number', min: 'The lowest number', max: 'The highest number', avg: 'The average', median: 'The median', p90: 'The 90th percentile', checks: 'Each rule another judge checked' }

/** A sentence that says what a sheet below it builds, in the words the model page reads it in. */
function Says({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-ink-900 px-3 py-2.5 text-[17px] leading-7 text-ink-200">{children}</p>
}

/** One choice under a sentence: its label above it, a whole row wide. */
function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  )
}

/** A count or a sum over one relation: the sentence it reads as, and the choices that make it. The window, the rate, and the rest are on the property itself. */
function CountSheet({ bp, all, name, anchor, onClose, onMore }: { bp: Blueprint; all: Blueprint[]; name: string; anchor: HTMLElement; onClose: () => void; onMore: () => void }) {
  const save = useSaveBlueprint()
  const namer = useBlueprintName()
  const def = bp.fields[name]
  const [agg, setAgg] = useState<AggregationDef | undefined>(def?.aggregation)
  if (!def || !agg) return null
  const reaches = reachesFrom(bp, all, namer)
  const reach = reachOf(agg.relation, bp, all, namer)
  const end = reach ? all.find((b) => b.id === reach.to) : undefined
  const numbers = Object.entries(end?.fields ?? {}).filter(([, f]) => f.type === 'number')
  const complete = agg.fn === 'count' || !!agg.field
  const dirty = JSON.stringify(agg) !== JSON.stringify(def.aggregation)
  const title = def.title ?? said(name)
  return (
    <Popover anchor={anchor} width={400} onClose={onClose} onOutside={dirty ? () => {} : onClose} unsaved={dirty} label={`How ${title} is worked out`} className="max-h-[85vh] space-y-4 overflow-y-auto p-4">
      <h2 className="text-[17px] font-semibold text-ink-100">{title}</h2>
      <Says>
        {title} is <span className="text-edit">{aggregationWords(agg, bp, all, namer)}</span>.
      </Says>
      <Choice label="What it works out">
        <select className={`${input} w-full`} value={agg.fn} onChange={(e) => setAgg({ ...agg, fn: e.target.value as AggregationDef['fn'], field: e.target.value === 'count' ? undefined : agg.field })}>
          {AGGREGATION_FNS.map((fn) => (
            <option key={fn} value={fn}>
              {FN_TITLES[fn]}
            </option>
          ))}
        </select>
      </Choice>
      <Choice label="Of every">
        <select className={`${input} w-full`} value={reach?.path ?? ''} onChange={(e) => setAgg({ ...agg, relation: e.target.value, field: undefined })}>
          {!reach && <option value="">{agg.relation}</option>}
          {reaches.map((r) => (
            <option key={r.path} value={r.path}>
              {r.words}
            </option>
          ))}
        </select>
      </Choice>
      {agg.fn !== 'count' && (
        <Choice label={`The number on each ${end ? namer(end) : 'one'}`}>
          <select className={`${input} w-full`} value={agg.field ?? ''} onChange={(e) => setAgg({ ...agg, field: e.target.value || undefined })}>
            <option value="">{numbers.length ? 'Pick a number' : 'It holds no number yet'}</option>
            {numbers.map(([k, f]) => (
              <option key={k} value={k}>
                {f.title ?? said(k)}
              </option>
            ))}
          </select>
        </Choice>
      )}
      <ErrorNote error={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button kind="solid" disabled={!dirty || !complete || save.isPending} onClick={() => save.mutate({ id: bp.id, spec: { ...specOf(bp), fields: { ...bp.fields, [name]: { ...def, aggregation: agg } } } }, { onSuccess: onClose })}>
          Save
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button opens="dialog" className="ml-auto" onClick={() => (!dirty || confirm(DISCARD)) && onMore()}>
          Window, rate, and more
        </Button>
      </div>
    </Popover>
  )
}

/** The last sentence, which adds a property or a relation to the blueprint: the sentence it will read as, and the choices that make it. Its name is made from the words typed. */
function Composer({ bp, all }: { bp: Blueprint; all: Blueprint[] }) {
  const save = useSaveBlueprint()
  const namer = useBlueprintName()
  const [mode, setMode] = useState<'field' | 'relation'>('field')
  const [type, setType] = useState<FieldType>('string')
  const [target, setTarget] = useState(bp.id)
  const [many, setMany] = useState(false)
  const [words, setWords] = useState('')
  const relation = mode === 'relation'
  const key = relation ? nameFor(words || target, Object.keys(bp.relations)) : nameFor(words, [...Object.keys(bp.fields), 'title'])
  const called = words.trim() || (relation ? namer(target) : '…')
  const add = () => {
    const title = words.trim() || undefined
    const spec = relation ? { ...specOf(bp), relations: { ...bp.relations, [key]: { target, ...(many ? { many } : {}), ...(title ? { title } : {}) } } } : { ...specOf(bp), fields: { ...bp.fields, [key]: { type, ...(title ? { title } : {}) } } }
    save.mutate({ id: bp.id, spec }, { onSuccess: () => setWords('') })
  }
  const targets = [...all].sort((a, b) => namer(a).localeCompare(namer(b)))
  return (
    <section aria-label="Add to it" className="space-y-3 rounded-xl border border-dashed border-orbit/60 bg-orbit/5 p-4">
      <div className="flex gap-2" role="group" aria-label="What to add">
        <Button pressed={!relation} onClick={() => setMode('field')}>
          A property
        </Button>
        <Button pressed={relation} onClick={() => setMode('relation')}>
          A relation
        </Button>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (key) add()
        }}
      >
        <Says>
          {relation ? (
            <>
              Each one also points at <span className="text-edit">{many ? 'many' : 'one'}</span> <span className="font-medium text-orbit">{namer(target)}</span> as <span className="font-medium text-orbit">{called}</span>.
            </>
          ) : (
            <>
              Each one also holds <span className="font-medium text-orbit">{called}</span>, <span className="text-edit">{kindWords({ type })}</span>.
            </>
          )}
        </Says>
        <Choice label="Called">
          <input className={`${input} w-full`} placeholder={relation ? namer(target) : 'Such as Maturity'} value={words} onChange={(e) => setWords(e.target.value)} />
        </Choice>
        {relation ? (
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Choice label="Points at">
              <select className={input} value={many ? 'many' : 'one'} onChange={(e) => setMany(e.target.value === 'many')}>
                <option value="one">one</option>
                <option value="many">many</option>
              </select>
            </Choice>
            <Choice label="Of">
              <select className={`${input} w-full`} value={target} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {namer(b)}
                  </option>
                ))}
              </select>
            </Choice>
          </div>
        ) : (
          <Choice label="Holds">
            <select className={`${input} w-full`} value={type} onChange={(e) => setType(e.target.value as FieldType)}>
              {KINDS.map((k) => (
                <option key={k.type} value={k.type}>
                  {k.words}
                </option>
              ))}
            </select>
          </Choice>
        )}
        <p className="text-[13px] text-ink-400">{key ? <>Kept as <span className="font-mono text-[12px] text-ink-300">{key}</span>.</> : 'Give it a name that starts with a letter.'}</p>
        <ErrorNote error={save.error} />
        <Button type="submit" kind="solid" disabled={!key || save.isPending}>
          <Plus className="size-4" aria-hidden /> Add {relation ? 'relation' : 'property'}
        </Button>
      </form>
    </section>
  )
}

/** The drawers a phone opens over the model: a blueprint's whole editor, a new one, an import, and the rules. */
function Drawers({ open, bp, all, count, canAuthor, onClose }: { open: Open | null; bp: Blueprint | null; all: Blueprint[]; count: number; canAuthor: boolean; onClose: () => void }) {
  const name = useBlueprintName()
  const [dirty, setDirty] = useState(false)
  if (!open || 'anchor' in open) return null
  const leave = () => (!dirty || confirm(DISCARD)) && (setDirty(false), onClose())
  if (open.what === 'details' || open.what === 'new') {
    const editing = open.what === 'details' ? bp : null
    return (
      <Drawer bare title={editing ? name(editing) : 'New blueprint'} onClose={leave}>
        <BlueprintEditor
          key={editing ? `${editing.id}:${editing.updatedAt}` : 'new'}
          bp={editing}
          all={all}
          canAuthor={canAuthor}
          count={count}
          onDirty={setDirty}
          onSaved={(saved) => {
            setDirty(false)
            if (saved !== editing?.id) navigate({ page: 'model', id: saved })
            onClose()
          }}
          onClose={leave}
        />
      </Drawer>
    )
  }
  if (open.what === 'import') {
    return (
      <Drawer bare title="Import a model" onClose={onClose}>
        <ImportPanel onClose={onClose} />
      </Drawer>
    )
  }
  return (
    <Drawer title="Rules" subtitle="Relations the hub draws by matching values, and which alerts land on what." onClose={onClose}>
      <div className="space-y-4 p-4">
        <RulesPanel canAuthor={canAuthor} blueprints={all} />
        <AlertRulesPanel canAuthor={canAuthor} blueprints={all} />
      </div>
    </Drawer>
  )
}
