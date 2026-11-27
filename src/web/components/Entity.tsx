import { ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Pencil, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { ENTITY_LINKS, type AssignedCheckView, type EntityPageResponse, type EntityPatch } from '../../shared/api.ts'
import { currencyOf, formatCurrency } from '../../shared/currency.ts'
import { linkIcon, linkLabel, linkMark, linksOf } from '../../shared/icons.ts'
import { EDITION_BLUEPRINT, REPORT_BLUEPRINT, SOURCE_BLUEPRINT, addressKey, type Blueprint, type Entity, type EntityRef, type FieldDef, type FieldProvenance, type Layer, type RelationEnd } from '../../shared/model.ts'
import { readPointing, useAccessGuard, useBlueprintName, useBlueprints, useSeesBlueprint, useEditEntity, useEntity, useEntityAction, useCanEdit, useIsAdmin, asViewed } from '../api.ts'
import { Icon } from '../icons.tsx'
import { isPhoto } from '../../shared/icons.ts'
import { ago, changeWords, humanTimes, short, when, words } from '../format.ts'
import { useZen } from '../zen.ts'
import { isSpec, specSummary } from '../spec.ts'
import { useBrowse } from '../browse.ts'
import { addWords, allOpened, anyOpened, opened as ruleOpens, putBack } from '../editable.ts'
import { EntityActions } from './ActionForm.tsx'
import { HomeActions } from './ActionStart.tsx'
import { HomeQueries } from './HomeQueries.tsx'
import { EntityStar } from './Star.tsx'
import { HomeReports } from './HomeReports.tsx'
import { SafePaths } from './SafePaths.tsx'
import { ReportOutline } from './ReportOutline.tsx'
import { EditReport } from './ReportCompose.tsx'
import { Orbit, type OrbitNode } from './Orbit.tsx'
import { SpecPanel } from './Spec.tsx'
import { useSwipe } from './swipe.ts'
import { incomingRows, type IncomingKind } from '../incoming.ts'
import { TypeGlyph } from './FieldType.tsx'
import { LevelPill } from './Scorecards.tsx'
import { EntityIcon, fieldLock, RelationEditor, relationPatch, TITLE_DEF, ValueEditor } from './editors.tsx'
import { MenuItem, Popover } from './Popover.tsx'
import { Badge, Button, Chip, Empty, ErrorNote, External, Kicker, Lamp, LAYER_LABEL, LAYER_STYLE, LEVEL_TEXT, Link, Panel, useNarrow } from './ui.tsx'
import { isTrend, TrendChart } from './Trend.tsx'
import { spot } from '../spots.ts'
import { useHere } from '../trail.ts'

type OnEdit = (patch: EntityPatch) => void

/** What a value a person may change looks like under the pointer. */
const EDITABLE = 'cursor-pointer hover:bg-ink-850 hover:shadow-[inset_0_0_0_1px_var(--color-ink-600)]'

/** On a phone a row of fields or relations stacks: its name and where it came from on one line, the value under them at the full width. */
const STACKED = 'max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto]'
const STACKED_LABEL = 'max-md:w-auto max-md:pb-0'
const STACKED_VALUE = 'max-md:col-span-2 max-md:row-start-2 max-md:px-1 max-md:pt-0 max-md:pb-2'
const STACKED_ASIDE = 'max-md:col-start-2 max-md:row-start-1 max-md:w-auto max-md:pb-0'

/** True when the click landed on something that acts on its own, so the value under it is not opened for editing. */
const onControl = (event: React.MouseEvent) => !!(event.target as HTMLElement).closest('a, button')

/**
 * The keyboard's way to change a value that a click changes where it stands.
 * It shows only while it has focus, beside the value, and opens the editor on
 * the element just before it. The value itself is no button: it may hold links.
 */
function ChangeKey({ label, onPress }: { label: string; onPress: (anchor: HTMLElement) => void }) {
  return (
    <button type="button" aria-label={label} className="sr-only min-h-6 rounded-sm border border-ink-600 bg-ink-850 px-2 py-1 text-[12px] font-medium text-ink-200 focus:not-sr-only focus:mt-1 focus:inline-block" onClick={(event) => onPress(event.currentTarget.previousElementSibling as HTMLElement)}>
      Change
    </button>
  )
}

/** A status said as a word, first in the line under a title. */
const STATUS_WORD = { green: 'Healthy', amber: 'Needs a look', red: 'Failing', grey: 'Unknown' } as const

export function EntityPage({ blueprint, entityKey }: { blueprint: string; entityKey: string }) {
  const ref = { blueprint, key: entityKey }
  const entity = useEntity(ref)
  const blueprints = useBlueprints()
  const name = useBlueprintName()
  const actions = useEntityAction(ref)
  const edit = useEditEntity()
  const canEdit = useCanEdit(blueprint)
  const seesSources = useSeesBlueprint(SOURCE_BLUEPRINT)
  const zen = useZen()
  const narrow = useNarrow()
  // Opened from a list on a phone: a swipe steps to the record before or after it.
  const browse = useBrowse(ref)
  const swipe = useSwipe({ onNext: browse?.next ?? undefined, onPrevious: browse?.previous ?? undefined })
  const [more, setMore] = useState<HTMLElement | null>(null)
  useHere(entity.data?.title)
  if (entity.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  if (!entity.data) return <Empty>No entity {blueprint}:{entityKey}. It may have been deleted and purged.</Empty>
  const e: EntityPageResponse = entity.data
  const bp = blueprints.data?.blueprints.find((b) => b.id === blueprint)
  // A report's layout is drawn as an outline of its own, never as a field of raw text.
  const fields = Object.entries(bp?.fields ?? {}).filter(([name]) => !(blueprint === REPORT_BLUEPRINT && name === 'layout'))
  const links = fields.flatMap(([k, f]) => (f.type === 'url' ? linksOf(e.fields[k]).map((url) => ({ url, icon: linkIcon(f, url), label: linkLabel(words(f.title ?? k), url, !!f.many) })) : []))
  const shadowed = Object.keys(e.provenance).filter((k) => e.provenance[k]?.layer === 'git' && (e.provenance[k]?.override || e.provenance[k]?.replaced !== undefined))
  const onEdit: OnEdit = (patch) => edit.mutate({ ref, patch })
  // A person with a photo is shown by it, large, beside their name.
  const portrait = isPhoto(e.icon)
  return (
    <div {...spot('entity.page')} className="space-y-6 py-3 md:py-6" {...(narrow && browse ? swipe : {})}>
      {browse && (
        <nav aria-label="Through the list" className="flex items-center gap-2 text-[13px] text-ink-400">
          <button type="button" className="btn btn-ghost" disabled={!browse.previous} onClick={() => browse.previous?.()}>
            <ChevronLeft className="size-4" aria-hidden /> Previous
          </button>
          <span className="flex-1 text-center" aria-live="polite">
            {browse.at + 1} of {browse.total}
          </span>
          <button type="button" className="btn btn-ghost" disabled={!browse.next} onClick={() => browse.next?.()}>
            Next <ChevronRight className="size-4" aria-hidden />
          </button>
        </nav>
      )}
      <header className="space-y-4">
        <div className="flex min-w-0 items-start gap-5">
          {portrait && <EntityIcon e={e} layer={e.provenance.icon?.layer} canEdit={canEdit || ruleOpens(e, 'field', 'icon')} onEdit={onEdit} className="size-20 md:size-28" large />}
          <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-ink-400">
            {!portrait && <EntityIcon e={e} layer={e.provenance.icon?.layer} canEdit={canEdit || ruleOpens(e, 'field', 'icon')} onEdit={onEdit} className="size-4" />}
            <Link to={{ page: 'inventory', blueprint }} className="py-1 font-medium text-ink-300 hover:text-ink-100">
              {name(bp ?? blueprint)}
            </Link>
            <span aria-hidden>·</span>
            <span className="font-mono text-[12px] break-all">{e.key}</span>
            {/* Said only when the model says what a person owns and this is the reader's. */}
            {e.yours && (
              <>
                <span aria-hidden>·</span>
                <span className="rounded-full border border-ink-600 px-2 text-[12px] font-medium text-ink-100">{e.yoursAs.length ? `Yours: ${e.yoursAs.join(', ')}` : 'Yours'}</span>
              </>
            )}
          </div>
          <Title e={e} canEdit={canEdit} onEdit={onEdit} className="mt-1" textClass="font-serif text-[38px] leading-[1.05] tracking-[-0.01em] text-ink-50 break-words md:text-[52px]" />
          {!zen && (
            <p className="mt-3 flex items-start gap-2.5 text-[15px]">
              <Lamp level={e.status.level} className="mt-1.5" />
              <span className={e.status.level === 'green' ? 'text-ink-200' : LEVEL_TEXT[e.status.level]}>
                <span className="font-medium">{STATUS_WORD[e.status.level]}</span>
                {e.status.reasons.length > 0 && <span className="break-words">. {humanTimes(e.status.reasons.join('. '))}</span>}
              </span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-400">
            {e.state !== 'active' && <Badge className="border-amber/60 text-amber">{e.state}</Badge>}
            {e.hidden && <Badge className="border-amber/60 text-amber" title="Kept out of every view unless the view asks for hidden entities">hidden</Badge>}
            {e.scorecards.map((s) => (
              <Link key={s.scorecard} to={{ page: 'scorecards', id: s.scorecard }} className="py-1" title={`${s.title}: ${s.levelName} of ${s.levels.join(' → ')}`}>
                <LevelPill name={`${s.title}: ${s.level < 0 ? 'No level' : s.levelName}`} index={s.level + 1} of={s.levels.length} />
              </Link>
            ))}
          </div>
          {/* Where it came from and when, as one quiet line. */}
          <p className="mt-1 text-[13px] text-ink-400">
            {e.owner === 'ui' ? 'Made here' : 'From '}
            {/* A reader who may not see sources gets the name with no link: the page behind it would refuse them. */}
            {e.owner !== 'ui' && (seesSources ? <Link to={{ page: 'entity', blueprint: SOURCE_BLUEPRINT, key: e.owner }} className="inline-block min-w-6 py-1 text-ink-200 hover:underline">{e.owner}</Link> : <span className="text-ink-200">{e.owner}</span>)}
            {e.scope ? ` · scope ${e.scope}` : ''} · seen {ago(e.lastSeenAt)} · changed {ago(e.updatedAt)}
          </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A report's record and an edition's stand behind the page people read: each opens it first. */}
          {blueprint === REPORT_BLUEPRINT && <Link to={{ page: 'report', key: entityKey }} className="btn btn-solid">Read the newest edition</Link>}
          {blueprint === EDITION_BLUEPRINT && typeof e.fields.number === 'number' && <Link to={{ page: 'report', key: entityKey.slice(0, entityKey.lastIndexOf('/')), edition: e.fields.number }} className="btn btn-solid">Read this edition</Link>}
          {blueprint === REPORT_BLUEPRINT && (e.actions ?? []).includes('orrery_report_edit') && <EditReport report={{ key: entityKey, title: e.title, layout: String(e.fields.layout ?? '') }} className="flex items-center gap-1.5 btn btn-ghost" />}
          <EntityStar e={e} words />
          <EntityActions entity={e} except={blueprint === REPORT_BLUEPRINT ? ['orrery_report_edit', 'orrery_report_restore'] : []} />
          {links.map(({ url, icon, label }) => (
            <External key={url} href={url} title={url} className="flex items-center gap-1.5 btn btn-ghost">
              {icon && <Icon name={icon} className="size-3.5" />}
              {label}
            </External>
          ))}
          <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={!!more} onClick={(event) => setMore(event.currentTarget)}>
            <Ellipsis className="size-4" aria-hidden />
            More
          </button>
          {more && (
            <Popover anchor={more} onClose={() => setMore(null)} width={240} menu label={`More for ${e.title}`} className="py-1">
              <MenuItem onClick={() => (location.assign(asViewed(`/v1/export?blueprint=${encodeURIComponent(blueprint)}&key=${encodeURIComponent(entityKey)}&scope=all`)), setMore(null))}>Download as YAML</MenuItem>
              {canEdit && shadowed.length > 0 && (
                <MenuItem title={`Drop the UI copy of ${shadowed.join(', ')} now that git provides them`} onClick={() => (actions.cleanup.mutate(), setMore(null))}>
                  Clean up {shadowed.length} shadowed
                </MenuItem>
              )}
              {canEdit && (e.hidden || e.owner !== 'ui') && (
                <MenuItem title={e.hidden ? 'Show it in every view again' : 'A source owns this entity and would recreate it, so it can only be hidden'} onClick={() => (actions.hide.mutate(!e.hidden), setMore(null))}>
                  {e.hidden ? 'Unhide' : 'Hide from every view'}
                </MenuItem>
              )}
              {canEdit && e.owner === 'ui' && (
                <MenuItem danger onClick={() => (setMore(null), confirm(`Delete ${e.title}?`) && actions.remove.mutate())}>
                  Delete
                </MenuItem>
              )}
            </Popover>
          )}
        </div>
      </header>
      <ErrorNote error={edit.error ?? actions.cleanup.error ?? actions.remove.error ?? actions.hide.error} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          {narrow && <Neighbours e={e} bp={bp} />}
          <HomeActions entity={e} />
          <HomeQueries entity={e} />
          <HomeReports entity={e} />
          {blueprint === REPORT_BLUEPRINT && typeof e.fields.layout === 'string' && <ReportOutline layout={e.fields.layout} />}
          {e.alerts.length > 0 && <AlertsList e={e} />}
          <SafePaths entity={e} />
          <Relations e={e} bp={bp} canEdit={canEdit} onEdit={onEdit} />
          <Fields e={e} bp={bp} defs={fields} canEdit={canEdit} onEdit={onEdit} />
          {fields.map(([name, def]) => {
            if (def.type !== 'openapi' || !isSpec(e.fields[name])) return null
            const p = e.provenance[name]
            return <SpecPanel key={name} field={name} title={words(def.title ?? name)} doc={e.fields[name]} previous={p?.layer === 'pushed' ? p.replaced : undefined} changedAt={p?.at} />
          })}
          {e.checks.length > 0 && <ChecksMatrix checks={e.checks} />}
        </div>
        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          {!narrow && <Neighbours e={e} bp={bp} />}
          {!bp?.noTimeline && <Panel>
            <div className="border-b border-ink-800 px-4 py-2">
              <Kicker>Timeline</Kicker>
            </div>
            <ul className="divide-y divide-ink-800">
              {e.changes.length === 0 && <li className="px-4 py-3 text-sm text-ink-400">No changes recorded.</li>}
              {e.changes.map((c) => (
                <li key={c.id} className="px-4 py-2 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-ink-200">{changeWords(c.kind)}</span>
                    <span className="text-[12px] text-ink-400">{who(c.actor ?? c.source)}</span>
                    <span className="ml-auto text-[12px] text-ink-500" title={c.at}>
                      {when(c.at)}
                    </span>
                  </div>
                  <div className="text-[12px] break-words text-ink-400" title={JSON.stringify(c.detail)}>
                    {describe(c.detail)}
                  </div>
                  <PutBack e={e} change={c} canEdit={canEdit} onEdit={onEdit} />
                </li>
              ))}
            </ul>
          </Panel>}
        </div>
      </div>
    </div>
  )
}

/** Under a hand edit that kept what it replaced: one press writes those values back, for whoever may change them here. */
function PutBack({ e, change, canEdit, onEdit }: { e: EntityPageResponse; change: EntityPageResponse['changes'][number]; canEdit: boolean; onEdit: OnEdit }) {
  const patch = change.kind === 'entity.updated' && change.outcome === 'ok' ? putBack(change.detail) : null
  if (!patch || !(canEdit || allOpened(e, patch))) return null
  const names = [...Object.keys(patch.fields ?? {}), ...Object.keys(patch.relations ?? {})].map(words).join(', ')
  return (
    <button type="button" className="mt-1 inline-flex items-center gap-1 rounded-sm text-[12px] text-ink-300 hover:text-ink-100 hover:underline" title={`Write back what ${names} held before this change`} onClick={() => onEdit(patch)}>
      <Undo2 className="size-3" aria-hidden />
      Put back
    </button>
  )
}

/** Beside the name of a value an edit rule opens to the reader here, where the page as a whole is not theirs to change. */
function YoursMark() {
  return (
    <span title="Yours to change">
      <Pencil aria-hidden className="ml-1.5 inline size-3 align-[-1px] text-ink-500" />
      <span className="sr-only"> (yours to change)</span>
    </span>
  )
}

/** The entity's title. A click renames it where it stands. */
function Title({ e, canEdit, onEdit, className, textClass }: { e: EntityPageResponse; canEdit: boolean; onEdit: OnEdit; className: string; textClass: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const from = e.provenance.title
  const may = canEdit || ruleOpens(e, 'field', 'title')
  const locked = !may || from?.layer === 'git'
  return (
    <>
      <h1 className={`${className} ${textClass} ${locked ? '' : `-mx-1 rounded-sm px-1 ${EDITABLE}`}`} title={locked ? (may ? `Set in git: ${from?.file ?? ''}` : undefined) : 'Click to rename'} onClick={locked ? undefined : (event) => setAnchor(event.currentTarget)}>
        {e.title}
      </h1>
      {!locked && <ChangeKey label="Rename" onPress={setAnchor} />}
      {anchor && <ValueEditor anchor={anchor} def={TITLE_DEF} value={e.title} textClass={textClass} onCommit={(value) => (onEdit({ fields: { title: value } }), setAnchor(null))} onClose={() => setAnchor(null)} />}
    </>
  )
}

function describe(detail: Record<string, unknown>): string {
  const parts: string[] = []
  if (Array.isArray(detail.fields) && detail.fields.length) parts.push(`${(detail.fields as string[]).map(words).join(', ')}`)
  if (Array.isArray(detail.relations) && detail.relations.length) parts.push(`${(detail.relations as string[]).map(words).join(', ')}`)
  if (typeof detail.field === 'string') parts.push(`${detail.field}: ${short(detail.basis)} → ${short(detail.pushed)}, dropped ${short(detail.override)}`)
  if (typeof detail.reason === 'string') parts.push(detail.reason)
  if (typeof detail.previous === 'string') parts.push(`was ${detail.previous}`)
  return parts.join(' · ')
}

/** Who made a change, as a person reads it: the name part of an address. */
const who = (actor: string | null) => (actor && /^[^@\s]+@[^@\s]+$/.test(actor) ? actor.split('@')[0]! : actor)

/** No value at all: nothing, an empty text, or an empty list. A zero or a false is a value. */
const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

function Fields({ e, bp, defs, canEdit, onEdit }: { e: EntityPageResponse; bp: Blueprint | undefined; defs: [string, FieldDef][]; canEdit: boolean; onEdit: OnEdit }) {
  const [editing, setEditing] = useState<{ name: string; def: FieldDef; anchor: HTMLElement } | null>(null)
  const admin = useIsAdmin()
  const guard = useAccessGuard(bp)
  const narrow = useNarrow()
  // A field with no value says nothing until someone asks: the empty ones wait under one row, so what is known reads first.
  const [blanks, setBlanks] = useState(false)
  // A zero worked out from elsewhere (a count, a sum) says only that nothing is there yet: it waits with the empty ones.
  // An empty field an edit rule opens to a reader who may change nothing else here is theirs to fill: it stays in view and says so.
  const toFill = (name: string) => !canEdit && ruleOpens(e, 'field', name)
  const idle = ([name, def]: [string, FieldDef]) => (blank(e.fields[name]) && !toFill(name)) || (e.fields[name] === 0 && !!(def.aggregation || def.calculation || def.mirror || def.derived))
  const empty = defs.filter(idle)
  const shown = blanks ? defs : defs.filter((d) => !idle(d))
  return (
    <Panel>
      <div className="flex items-center border-b border-ink-800 px-4 py-2">
        <Kicker>Details</Kicker>
        {canEdit ? <span className="ml-auto text-[12px] text-ink-400">{narrow ? 'Tap' : 'Click'} a value to change it</span> : anyOpened(e) && <span className="ml-auto text-[12px] text-ink-400">A pencil marks what is yours to change</span>}
      </div>
      <table className="w-full text-sm max-md:block md:table-fixed">
        <tbody className="max-md:block">
          {shown.map(([name, def]) => {
            const value = e.fields[name]
            const from = e.provenance[name]
            const held = canEdit ? (fieldLock(def, from?.layer, admin) ?? guard(name)) : ''
            // A rule that opens the value to the reader on this entity lifts whatever kept it from them.
            const mine = held !== null && ruleOpens(e, 'field', name)
            const lock = mine ? null : held
            return (
              <tr key={name} className={`border-b border-ink-800 align-top last:border-0 ${STACKED}`}>
                <td className={`w-28 px-3 py-2 text-[13px] break-words text-ink-400 md:w-56 md:px-4 ${STACKED_LABEL}`} title={def.description}>
                  <TypeGlyph def={def} className="mr-1.5 inline align-[-2px]" />
                  {words(def.title ?? name)}
                  {def.description && <span className="ml-1 text-ink-500">ⓘ</span>}
                  {mine && <YoursMark />}
                </td>
                <td className={`px-2 py-1 ${STACKED_VALUE}`}>
                  <div className={`min-h-7 rounded-sm px-2 py-1 whitespace-pre-wrap [overflow-wrap:anywhere] ${lock === null ? EDITABLE : ''}`} title={lock ? (from?.file ? `${lock} (${from.file})` : lock) : undefined} onClick={lock === null ? (event) => !onControl(event) && setEditing({ name, def, anchor: event.currentTarget }) : undefined}>
                    {mine && blank(value) ? <span className="text-ink-500">{addWords(words(def.title ?? name))}</span> : <Value value={value} def={def} people={e.people} />}
                  </div>
                  {lock === null && <ChangeKey label={`Change ${def.title ?? name}`} onPress={(anchor) => setEditing({ name, def, anchor })} />}
                </td>
                <td className={`w-px px-3 py-2 text-right whitespace-nowrap md:w-36 ${STACKED_ASIDE}`}>{from && <Provenance p={from} onRevert={lock === null && from.layer === 'override' ? () => onEdit({ fields: { [name]: null } }) : undefined} />}</td>
              </tr>
            )
          })}
          {empty.length > 0 && (
            <tr className="max-md:block">
              <td colSpan={3} className="max-md:block">
                <button type="button" aria-expanded={blanks} onClick={() => setBlanks(!blanks)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-ink-400 hover:text-ink-200">
                  {blanks ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                  {blanks ? 'Hide the empty fields' : `${empty.length} empty ${empty.length === 1 ? 'field' : 'fields'}`}
                </button>
              </td>
            </tr>
          )}
          {defs.length === 0 && (
            <tr>
              <td className="px-4 py-3 text-sm text-ink-400">This blueprint has no fields yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && <ValueEditor anchor={editing.anchor} def={editing.def} value={e.fields[editing.name]} onCommit={(value) => (onEdit({ fields: { [editing.name]: value } }), setEditing(null))} onClose={() => setEditing(null)} />}
    </Panel>
  )
}

function Provenance({ p, onRevert }: { p: FieldProvenance; onRevert?: () => void }) {
  const parts: string[] = []
  if (p.source) parts.push(`from ${p.source}`)
  if (p.at) parts.push(`at ${p.at}`)
  if (p.file) parts.push(p.file)
  if (p.replaced !== undefined) parts.push(`replaces ${short(p.replaced, 200)}`)
  if (p.override && p.layer !== 'override') parts.push(`override ${short(p.override.value)} by ${p.override.by}`)
  return (
    <span className="inline-flex items-center gap-1">
      {onRevert && (
        <button type="button" className="grid size-6 place-items-center rounded-sm text-ink-400 hover:bg-ink-700 hover:text-ink-100" title={`Back to the pushed value: ${short(p.replaced, 200)}`} onClick={onRevert}>
          <Undo2 className="size-3" />
        </button>
      )}
      <LayerBadge layer={p.layer} title={parts.join('\n')} />
    </span>
  )
}

/** Where a value came from. A person's own edit and an override stand out; the usual sources are a quiet word. */
function LayerBadge({ layer, title }: { layer: Layer; title?: string }) {
  if (layer !== 'ui' && layer !== 'override')
    return (
      <span className="text-[12px] text-ink-400" title={title}>
        {LAYER_LABEL[layer]}
      </span>
    )
  return (
    <Badge className={LAYER_STYLE[layer]} title={title}>
      {LAYER_LABEL[layer]}
    </Badge>
  )
}

/** A field's value read in full: every link, every item of a list, long text unclipped. The entity page and the grid's inspector both show a value this way. */
export function Value({ value, def, people }: { value: unknown; def: FieldDef | undefined; people?: Entity['people'] }) {
  if (value === null || value === undefined || value === '') return <span className="text-ink-500">—</span>
  if (def?.type === 'user' && people) {
    // A person the hub knows is a link to them; an address that is nobody here stays the text it is.
    const values = (Array.isArray(value) ? value : [value]).filter((x): x is string => typeof x === 'string')
    if (values.some((x) => people[addressKey(x)]))
      return (
        <span className="flex flex-col gap-1">
          {values.map((x) => {
            const person = people[addressKey(x)]
            return person ? (
              <Link key={x} to={{ page: 'entity', blueprint: person.blueprint, key: person.key }} className="inline-flex min-h-6 items-center gap-1.5 [overflow-wrap:anywhere] text-orbit hover:underline" title={x}>
                {person.icon && <Icon name={person.icon} className="size-4 shrink-0 text-ink-400" />}
                {person.title}
              </Link>
            ) : (
              <span key={x}>{x}</span>
            )
          })}
        </span>
      )
  }
  if ((def?.type === 'url' || def?.type === 'openapi') && linksOf(value).length) {
    return (
      <span className="flex flex-col gap-1">
        {linksOf(value).map((url) => {
          const icon = linkMark(def, url)
          return (
            <External key={url} href={url} className="inline-flex min-h-6 items-center gap-1.5 [overflow-wrap:anywhere] text-orbit">
              {icon && <Icon name={icon} className="size-4 shrink-0" />}
              {url}
            </External>
          )
        })}
      </span>
    )
  }
  if (def?.type === 'datetime' && typeof value === 'string') return <span className="tabular-nums" title={value}>{when(value)} · {ago(value)}</span>
  if (def?.type === 'trend' && isTrend(value))
    return (
      <div className="w-full max-w-[460px]">
        <TrendChart value={value} />
      </div>
    )
  if ((def?.type === 'enum' || def?.chip) && typeof value === 'string') return <Chip value={value} def={def} />
  if (def?.type === 'enum' && def.many && Array.isArray(value))
    return (
      <span className="flex flex-wrap gap-1">
        {value.filter((x): x is string => typeof x === 'string').map((x) => (
          <Chip key={x} value={x} def={def} />
        ))}
      </span>
    )
  if (typeof value === 'boolean') return <Chip value={String(value)} label={value ? 'yes' : 'no'} def={def} />
  if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string' || typeof x === 'number'))
    return (
      <ul className="flex flex-col gap-1">
        {value.map((x, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">{x}</li>
        ))}
      </ul>
    )
  if (typeof value === 'number') {
    const money = currencyOf(def)
    return <span className="tabular-nums" title={money ? String(value) : undefined}>{money ? formatCurrency(value, money) : value}</span>
  }
  if (typeof value === 'string') return <span>{value}</span>
  // The document itself is read in its own panel under the details.
  if (def?.type === 'openapi' && isSpec(value)) return <span>{specSummary(value)}</span>
  return <pre className="font-mono text-[12px] whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-300">{JSON.stringify(value, null, 1)}</pre>
}

/** On a phone, what the record is joined to, one step out, in a ring around it. A tap opens that record. */
/** The icon a group of ends draws: the one they all draw, else their blueprint's. A target with no derived row draws its blueprint's. */
function sharedIcon(ends: RelationEnd[], byId: Map<string, Pick<Blueprint, 'icon'>>): string | undefined {
  const icons = new Set(ends.map((x) => x.targetIcon ?? byId.get(x.target.blueprint)?.icon))
  return icons.size === 1 ? [...icons][0] : byId.get(ends[0]!.target.blueprint)?.icon
}

/** What this thing is joined to, one node per way it is joined, with how many: a picture of how it fits that stays readable however many neighbours there are. A node goes to its row under Connections. */
function Neighbours({ e, bp }: { e: EntityPageResponse; bp: Blueprint | undefined }) {
  const all = useBlueprints().data?.blueprints
  const byId = new Map(all?.map((b) => [b.id, b]))
  const ring: OrbitNode[] = []
  const go = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  for (const [relation, ends] of Map.groupBy(e.outgoing.filter((o) => bp?.relations[o.relation]), (o) => o.relation)) {
    const id = `rel-out-${relation}`
    ring.push({ id, title: `${words(bp?.relations[relation]?.title ?? relation)}\u00a0·\u00a0${ends.length}`, icon: <Icon name={sharedIcon(ends, byId)} className="size-5" />, caption: ends.map((x) => x.targetTitle ?? x.target.key).join(', '), direction: 'out', onPick: go(id) })
  }
  for (const row of incomingRows(e.incoming, e.incomingCount)) {
    const ends = row.kinds.flatMap((k) => k.ends)
    ring.push({ id: row.id, title: `${row.title}\u00a0·\u00a0${row.count}`, icon: <Icon name={sharedIcon(ends, byId)} className="size-5" />, caption: ends.map((x) => x.targetTitle ?? x.target.key).join(', '), direction: 'in', onPick: go(row.id) })
  }
  if (ring.length === 0) return null
  return (
    <Panel className="px-2 py-4">
      <Orbit title={e.title} icon={<Icon name={e.icon ?? bp?.icon} className="size-7" />} level={e.status.level} nodes={ring} />
    </Panel>
  )
}

/** One kind of thing pointing here: the first the page was sent, and the rest read a page at a time when asked for. */
function Pointing({ kind, to }: { kind: IncomingKind; to: EntityRef }) {
  const all = useBlueprints().data?.blueprints
  const byId = new Map(all?.map((b) => [b.id, b]))
  const named = useBlueprintName()
  const [more, setMore] = useState<{ ends: Pick<RelationEnd, 'target' | 'targetTitle' | 'targetIcon' | 'dangling'>[]; next: string | null } | null>(null)
  const [reading, setReading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const shown = [...kind.ends, ...(more?.ends ?? [])]
  const left = kind.count - shown.length
  const readMore = async () => {
    setReading(true)
    setFailed(null)
    try {
      const page = await readPointing(kind.blueprint, kind.relation, to, more?.next ? { after: more.next } : { offset: kind.ends.length })
      setMore({ ends: [...(more?.ends ?? []), ...page.entities.map((p) => ({ target: { blueprint: p.blueprint, key: p.key }, targetTitle: p.title, targetIcon: p.icon, dangling: p.state !== 'active' }))], next: page.next })
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setReading(false)
    }
  }
  return (
    <div className="min-w-0">
      {shown.map((end) => (
        <Link key={end.target.key} to={{ page: 'entity', ...end.target }} className={`mr-1.5 mb-1 inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[13px] hover:border-ink-500 ${end.dangling ? 'text-ink-300' : 'text-ink-100'}`} title={end.dangling ? `${named(end.target.blueprint)}: missing or deleted` : named(end.target.blueprint)}>
          <Icon name={end.targetIcon ?? byId.get(end.target.blueprint)?.icon} className="size-3.5 shrink-0 text-ink-400" />
          <span className="break-words">{end.targetTitle ?? end.target.key}</span>
          {end.dangling && <span className="text-[12px] text-ink-400">missing</span>}
        </Link>
      ))}
      {left > 0 && (
        <button type="button" className="mb-1 rounded-full px-2 py-1 text-[13px] text-ink-300 hover:text-ink-100 disabled:opacity-60" disabled={reading} onClick={() => void readMore()}>
          {reading ? 'Reading…' : `${left} more`}
        </button>
      )}
      {more && shown.length > kind.ends.length && (
        <button type="button" className="mb-1 rounded-full px-2 py-1 text-[13px] text-ink-300 hover:text-ink-100" onClick={() => setMore(null)}>
          Show fewer
        </button>
      )}
      {failed && <span className="text-[12px] text-red">{failed}</span>}
    </div>
  )
}

function Relations({ e, bp, canEdit, onEdit }: { e: EntityPageResponse; bp: Blueprint | undefined; canEdit: boolean; onEdit: OnEdit }) {
  const [editing, setEditing] = useState<{ name: string; anchor: HTMLElement } | null>(null)
  const declared = Object.entries(bp?.relations ?? {})
  const editingDef = editing ? bp?.relations[editing.name] : undefined
  const all = useBlueprints().data?.blueprints
  const byId = new Map(all?.map((b) => [b.id, b]))
  const named = useBlueprintName()
  const guard = useAccessGuard(bp)
  // What points here, one row per thing it says, split by kind when several blueprints say it.
  const incoming = incomingRows(e.incoming, e.incomingCount)
  // A relation that points nowhere waits under one row, as an empty field does.
  const [blanks, setBlanks] = useState(false)
  // A relation with many targets shows its first few, as what points here does, until it is opened.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const openRow = (name: string, open: boolean) => setOpened((was) => {
    const next = new Set(was)
    if (open) next.add(name)
    else next.delete(name)
    return next
  })
  const unset = declared.filter(([name]) => !e.outgoing.some((o) => o.relation === name)).length
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Connections</Kicker>
      </div>
      <table className="w-full text-sm max-md:block md:table-fixed">
        <tbody className="max-md:block">
          {(blanks ? declared : declared.filter(([name]) => e.outgoing.some((o) => o.relation === name) || (!canEdit && ruleOpens(e, 'relation', name)))).map(([name, def]) => {
            const ends = e.outgoing.filter((o) => o.relation === name)
            const layer = ends[0]?.layer
            const guarded = canEdit ? guard(name) : null
            const mine = !(canEdit && !guarded) && ruleOpens(e, 'relation', name)
            const editable = (mine || (canEdit && !guarded)) && layer !== 'git'
            const shown = opened.has(name) ? ends : ends.slice(0, ENTITY_LINKS)
            return (
              <tr key={name} id={`rel-out-${name}`} className={`scroll-mt-24 border-b border-ink-800 align-top ${STACKED}`}>
                <td className={`w-28 px-3 py-2 text-[13px] break-words text-ink-400 md:w-56 md:px-4 ${STACKED_LABEL}`} title={`${def.description ? `${def.description} ` : ''}Points at ${named(def.target)}`}>
                  {def.title ?? words(name)}
                  {def.display === 'contain' && <span className="ml-1 text-ink-500" title="Lives inside the target">⊂</span>}
                  {ends.length > 1 && <span className="ml-1.5 text-ink-400">{ends.length}</span>}
                  {mine && <YoursMark />}
                </td>
                <td className={`px-2 py-1 ${STACKED_VALUE}`}>
                  <div className={`min-h-7 rounded-sm px-2 py-1 [overflow-wrap:anywhere] ${editable ? EDITABLE : ''}`} title={canEdit && layer === 'git' ? 'Set in git: change it there' : (guarded ?? undefined)} onClick={editable ? (event) => !onControl(event) && setEditing({ name, anchor: event.currentTarget }) : undefined}>
                    {ends.length === 0 && <span className="text-ink-500">{mine ? addWords(def.title ?? words(name)) : '—'}</span>}
                    {shown.map((end) => (
                      <span key={end.target.key} className="mr-1.5 mb-1 inline-flex items-center gap-1">
                        <Link to={{ page: 'entity', ...end.target }} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[13px] hover:border-ink-500 ${end.pending || end.dangling ? 'border-amber/50 text-amber' : 'border-ink-700 bg-ink-850 text-ink-100'}`} title={end.pending ? 'Pending: the target has not arrived yet' : end.dangling ? 'The target is missing or deleted' : undefined}>
                          <Icon name={end.targetIcon ?? byId.get(end.target.blueprint)?.icon} className="size-3.5 shrink-0 text-ink-400" />
                          {end.targetTitle ?? end.target.key}
                        </Link>
                        {(end.pending || end.dangling) && <span className="text-[12px] text-amber">{end.pending ? 'pending' : 'broken'}</span>}
                      </span>
                    ))}
                    {shown.length < ends.length && (
                      <button type="button" className="mb-1 rounded-full px-2 py-1 text-[13px] text-ink-300 hover:text-ink-100" onClick={() => openRow(name, true)}>
                        {ends.length - shown.length} more
                      </button>
                    )}
                    {opened.has(name) && ends.length > ENTITY_LINKS && (
                      <button type="button" className="mb-1 rounded-full px-2 py-1 text-[13px] text-ink-300 hover:text-ink-100" onClick={() => openRow(name, false)}>
                        Show fewer
                      </button>
                    )}
                  </div>
                  {editable && <ChangeKey label={`Change ${def.title ?? name}`} onPress={(anchor) => setEditing({ name, anchor })} />}
                </td>
                <td className={`w-px px-3 py-2 text-right whitespace-nowrap md:w-36 ${STACKED_ASIDE}`}>
                  {layer && (
                    <span className="inline-flex items-center gap-1">
                      {editable && layer === 'ui' && (
                        <button type="button" className="grid size-6 place-items-center rounded-sm text-ink-400 hover:bg-ink-700 hover:text-ink-100" title="Drop what was set here and go back to what sources and rules say" onClick={() => onEdit({ relations: { [name]: null } })}>
                          <Undo2 className="size-3" />
                        </button>
                      )}
                      <LayerBadge layer={layer} />
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
          {incoming.map(({ id, title, count, kinds }) => (
            <tr key={id} id={id} className={`scroll-mt-24 border-b border-ink-800 align-top last:border-0 ${STACKED}`}>
              <td className={`w-28 px-3 py-2 text-[13px] break-words text-ink-400 md:w-56 md:px-4 ${STACKED_LABEL}`} title="Points here from elsewhere">
                <span className="text-ink-400" aria-hidden>← </span>
                {title}
                <span className="ml-1.5 text-ink-400">{count}</span>
              </td>
              <td className="px-3 py-1.5 max-md:col-span-2 max-md:pt-1" colSpan={2}>
                {kinds.map((kind) => (
                  <div key={`${id}:${kind.blueprint}.${kind.relation}`} className={kinds.length > 1 ? 'mb-1 flex items-start gap-2 max-md:flex-col max-md:gap-0' : undefined}>
                    {kinds.length > 1 && (
                      <span className="w-36 shrink-0 truncate py-1 text-[12px] text-ink-400" title={`${named(kind.blueprint)}, by ${words(kind.relation)}`}>
                        {named(kind.blueprint)} <span className="text-ink-500">{kind.count}</span>
                      </span>
                    )}
                    <Pointing kind={kind} to={e} />
                  </div>
                ))}
              </td>
            </tr>
          ))}
          {unset > 0 && (
            <tr className="max-md:block">
              <td colSpan={3} className="max-md:block">
                <button type="button" aria-expanded={blanks} onClick={() => setBlanks(!blanks)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-ink-400 hover:text-ink-200">
                  {blanks ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                  {blanks ? 'Hide the empty relations' : `${unset} empty ${unset === 1 ? 'relation' : 'relations'}`}
                </button>
              </td>
            </tr>
          )}
          {declared.length === 0 && e.incoming.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-3 text-sm text-ink-400">
                No relations declared or received.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && editingDef && (
        <RelationEditor anchor={editing.anchor} target={editingDef.target} many={!!editingDef.many} value={e.relations[editing.name] ?? []} onCommit={(targets) => (onEdit(relationPatch(editing.name, !!editingDef.many, targets)), setEditing(null))} onClose={() => setEditing(null)} />
      )}
    </Panel>
  )
}

/** Reachability matrix: one row per check field, one column per runner. */
function ChecksMatrix({ checks }: { checks: AssignedCheckView[] }) {
  const runners = [...new Set(checks.flatMap((c) => c.check.runners))]
  return (
    <Panel className="overflow-x-auto">
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Health checks</Kicker>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-800 label">
            <th className="px-4 py-1.5 text-left">Check</th>
            {runners.map((r) => (
              <th key={r} className="px-2 py-1.5 text-left">
                from {r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.field} className="border-b border-ink-800 last:border-0 align-top">
              <td className="px-4 py-2">
                <div className="font-mono text-[12px]">{c.field}</div>
                <div className="truncate font-mono text-[12px] text-ink-400" title={c.check.url}>
                  {c.check.method} {c.check.url.replace(/^https?:\/\//, '')} · expect {c.check.expect} {String(c.check.expectStatus)}
                  {c.check.auth ? ` · auth ${c.check.auth.type} (${c.check.auth.secretRef})` : ''}
                </div>
              </td>
              {runners.map((r) => {
                const res = c.results.find((x) => x.runner === r)
                const assigned = c.check.runners.includes(r)
                if (!assigned) return <td key={r} className="px-2 py-2 text-ink-500">—</td>
                if (!res) return <td key={r} className="px-2 py-2 font-mono text-[12px] text-ink-500">no result yet</td>
                const healthy = c.check.expect === 'reachable' ? res.ok : !res.ok
                return (
                  <td key={r} className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <Lamp level={healthy ? 'green' : 'red'} />
                      <span className="font-mono text-[12px]">
                        {res.status ?? 'no answer'}
                        {res.latencyMs !== null ? ` · ${res.latencyMs}ms` : ''}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-ink-500" title={res.at}>
                      {res.error ?? ''} {ago(res.at)}
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

function AlertsList({ e }: { e: EntityPageResponse }) {
  return (
    <Panel>
      <div className="border-b border-ink-800 px-4 py-2">
        <Kicker>Firing alerts · {e.alerts.length}</Kicker>
      </div>
      {e.alerts.map((a) => (
        <div key={a.fingerprint} className="flex items-start gap-3 border-b border-ink-800 px-4 py-2 last:border-0">
          <Lamp level={/^(critical|page|high)$/i.test(a.labels.severity ?? '') ? 'red' : 'amber'} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm">{a.labels.alertname ?? a.fingerprint}</div>
            <div className="text-[12px] text-ink-300">{a.annotations.summary ?? a.annotations.description ?? ''}</div>
            <div className="truncate font-mono text-[10px] text-ink-500" title={JSON.stringify(a.labels)}>
              {Object.entries(a.labels)
                .filter(([k]) => k !== 'alertname')
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')}
            </div>
          </div>
          <span className="font-mono text-[10px] text-ink-500">since {ago(a.startsAt)}</span>
        </div>
      ))}
    </Panel>
  )
}

/** One entity in a narrow column, beside the catalog table: the same fields and relations, changed the same way. */
export function EntityPanel({ entityRef, onClose, onHide }: { entityRef: EntityRef; onClose: () => void; onHide?: () => void }) {
  const entity = useEntity(entityRef)
  const blueprints = useBlueprints()
  const name = useBlueprintName()
  const edit = useEditEntity()
  const canEdit = useCanEdit(entityRef.blueprint)
  const zen = useZen()
  if (!entity.data) return <div className="p-4 text-sm text-ink-400">Loading…</div>
  const e = entity.data
  const bp = blueprints.data?.blueprints.find((b) => b.id === entityRef.blueprint)
  const onEdit: OnEdit = (patch) => edit.mutate({ ref: entityRef, patch })
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <Lamp level={e.status.level} size="lg" className="mt-1.5" calm />
        <div className="mt-0.5">
          <EntityIcon e={e} layer={e.provenance.icon?.layer} canEdit={canEdit || ruleOpens(e, 'field', 'icon')} onEdit={onEdit} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Kicker>{name(bp ?? entityRef.blueprint)}</Kicker>
          <Title e={e} canEdit={canEdit} onEdit={onEdit} className="truncate" textClass="text-lg font-semibold" />
          {!zen && e.status.reasons.map((r) => (
            <div key={r} className={`font-mono text-[12px] ${LEVEL_TEXT[e.status.level]}`}>
              {humanTimes(r)}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <Link to={{ page: 'entity', ...entityRef }} className="btn btn-ghost px-2 py-1 text-[12px]">
            Open
          </Link>
          {onHide && <Button onClick={onHide}>Hide</Button>}
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 empty:hidden">
        <EntityActions entity={e} size="sm" />
      </div>
      <ErrorNote error={edit.error} />
      <Fields e={e} bp={bp} defs={Object.entries(bp?.fields ?? {})} canEdit={canEdit} onEdit={onEdit} />
      {e.checks.length > 0 && <ChecksMatrix checks={e.checks} />}
      <Relations e={e} bp={bp} canEdit={canEdit} onEdit={onEdit} />
    </div>
  )
}

