// The front page, spoken to the reader: how their own things are, in one
// sentence; what of theirs needs them, worst first; the rest of what they may
// see as a sky of areas and kinds; and, quietly, what needs someone elsewhere.
// A reader who owns nothing, or whom the hub cannot place, is told so plainly,
// and the page speaks for what is shared with them. Everything here is read
// from the reader's own answers; `now.ts` shapes it.

import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useId, useRef, useState, type ReactNode, type Ref } from 'react'
import type { MineResponse } from '../../shared/api.ts'
import type { GroundCover } from '../../shared/ground.ts'
import { entityId, type Blueprint } from '../../shared/model.ts'
import { useAlerts, useBlueprintName, useBlueprints, useGroundIndex, useIsAdmin, useMine, useMineFill, useMineKind, usePreview, useSummary } from '../api.ts'
import { fillWords } from '../editable.ts'
import { ago, humanTimes, middle } from '../format.ts'
import { coverText } from '../ground.ts'
import { BlueprintIcon } from '../icons.tsx'
import { alertsOn, areasOf, bySize, elsewhereOf, firstArea, needsOf, numbered, ownKinds, ownRoles, perspectiveOf, tallyOf, verdictOf, worse, yoursOf, type Area, type Kind, type Need, type Perspective, type Tally } from '../now.ts'
import { navigate, type Route } from '../router.ts'
import { useCommand } from './Command.tsx'
import { Sky } from './Sky.tsx'
import { ErrorNote, Lamp, LEVEL_NAME, LEVEL_TEXT, Link, useDesk, useNarrow } from './ui.tsx'
import { spot } from '../spots.ts'
import { useZen } from '../zen.ts'
import { useVisit } from '../trail.ts'

/** How many of a stack of what needs a person show before the rest is asked for. */
const FIRST = 4

export function Now() {
  const summary = useSummary()
  const alerts = useAlerts()
  const blueprints = useBlueprints()
  const mine = useMine()
  const name = useBlueprintName()
  const open = useCommand()
  const desk = useDesk()
  // The ground under the sky, for a reader the garden preview is open to: asked for, and drawn, for nobody else.
  const garden = usePreview('garden')
  const grounds = useGroundIndex(garden).data?.grounds
  const [picked, setPicked] = useVisit<string | null>('now.picked', null)
  const [lit, setLit] = useState<string | null>(null)
  // The list of what needs someone elsewhere, open or not: the line under the verdict opens it too.
  const [others, setOthers] = useState(false)
  const othersAt = useRef<HTMLElement>(null)
  // Zen mode speaks of the estate, not of what fails: a quiet headline, a still sky, and what needs attention folded into one line.
  const zen = useZen()
  const error = summary.error ?? mine.error
  if (error) return <ErrorNote error={error} />
  if (!summary.data || !blueprints.data || !mine.data) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const firing = alerts.data?.alerts ?? []
  const view = perspectiveOf(mine.data)
  const own = view.whose === 'yours'
  // The verdict and what needs the reader speak for what is theirs when the hub knows, else for everything they see.
  const subject = own ? yoursOf(mine.data) : summary.data
  const theirAlerts = own ? alertsOn(firing) : firing
  const verdict = verdictOf(subject, theirAlerts, view.whose)
  const needs = needsOf(subject, theirAlerts, !own)
  // What the reader sees that is not theirs, told apart so it never reads as theirs.
  const elsewhere = own
    ? (() => {
        const others = alertsOn(firing, false)
        // What of theirs is not green is all in what the hub said is theirs.
        const ownNotGreen = new Set(mine.data.things.map((t) => entityId(t.entity)))
        const notGreen = summary.data.notGreen.filter((c) => !ownNotGreen.has(entityId(c.entity)))
        const all = tallyOf(summary.data, others)
        const theirs = tallyOf(subject, [])
        return { needs: needsOf({ notGreen }, others), tally: { failing: all.failing - theirs.failing, firing: all.firing, look: all.look - theirs.look } }
      })()
    : null
  const areas = areasOf(blueprints.data.blueprints, summary.data, name)
  const total = areas.reduce((n, a) => n + a.count, 0)
  // The area open below the sky: the one a person chose, or else where their own things are, or else the worst.
  const area = areas.find((a) => a.name === picked) ?? firstArea(areas, own ? mine.data.blueprints : null)
  const outside = elsewhere ? elsewhereOf(elsewhere.tally, view.seesAll) : null
  const failing = areas.reduce((n, a) => n + a.notGreen.red, 0)
  const failingYours = own ? Object.values(mine.data.blueprints).reduce((n, b) => n + b.notGreen.red, 0) : 0
  const skyHeading = view.seesAll ? 'The whole estate' : 'Everything shared with you'
  const byId = new Map(blueprints.data.blueprints.map((b) => [b.id, b]))
  // How the chosen area joins the rest: every relation that starts or ends at one of its kinds.
  const inArea = new Set(area?.kinds.map((k) => k.id))
  const links = blueprints.data.blueprints.flatMap((b) => Object.values(b.relations).filter((r) => inArea.has(b.id) || inArea.has(r.target)).map((r) => ({ from: b.id, to: r.target })))
  const label = (id: string) => name(byId.get(id) ?? id)
  const marks = area ? numbered(area) : []
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 pt-6 pb-10 md:pt-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:grid-rows-[auto_auto_1fr] 2xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] desk:h-full desk:grid-rows-[auto_minmax(0,1fr)_auto] desk:gap-y-4 desk:pb-6">
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-x-8 gap-y-4 xl:col-start-1 xl:row-start-1 xl:flex-nowrap">
        <div {...spot('now.verdict')} className="min-w-0 flex-1">
          <p className="label">{own ? 'Now, for what you own' : view.seesAll ? 'Now, across the estate' : 'Now, across what is shared with you'}</p>
          <h1 className="mt-2 font-serif text-[32px] leading-[1.1] tracking-[-0.01em] text-ink-50 md:text-[40px] desk:text-[36px]">
            {zen ? (own ? `${plural(mine.data.count, 'thing is', 'things are')} yours.` : `${plural(total, 'thing')} ${view.seesAll ? 'in the estate' : 'shared with you'}.`) : <>
            {verdict.lead && (
              <Link to={{ page: 'entity', ...verdict.lead.entity }} title={verdict.lead.title} className={`italic underline decoration-1 underline-offset-[6px] hover:decoration-2 ${LEVEL_TEXT.red}`}>
                {middle(verdict.lead.title)}
              </Link>
            )}
            {verdict.count && <span className={LEVEL_TEXT[verdict.level]}>{verdict.count}</span>}
            {verdict.rest}
            </>}
          </h1>
          <p className="mt-2 flex max-w-[80ch] flex-wrap items-baseline gap-x-4 gap-y-1 text-[14px]">
            <Whose view={view} mine={mine.data} />
            {outside && !zen && (
              <span className="inline-flex flex-wrap items-baseline gap-x-3">
                <span className={`inline-flex items-baseline gap-2 ${LEVEL_TEXT[outside.level]}`}>
                  <Lamp level={outside.level} />
                  {outside.text}
                </span>
                <button
                  type="button"
                  aria-expanded={others}
                  onClick={() => {
                    setOthers(true)
                    othersAt.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  className="font-medium text-ink-100 underline decoration-ink-600 underline-offset-4 hover:decoration-ink-300"
                >
                  Show them
                </button>
              </span>
            )}
          </p>
        </div>
        {/* A desk finds from the strip above every page; a phone has no strip, so Now keeps its own box there. */}
        <button type="button" {...spot('find')} onClick={() => open(true)} aria-haspopup="dialog" className="flex w-full shrink-0 items-center gap-3 rounded-2xl border border-ink-700 bg-ink-900 px-4 py-3 text-left text-[15px] text-ink-400 elevate-card transition-colors hover:border-ink-600 hover:text-ink-200 sm:w-[320px] md:hidden">
          <Search className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="sm:hidden">Find anything</span>
            <span className="hidden sm:inline">
              Find any of {total.toLocaleString('en-US')} things{view.seesAll ? '' : ' you can see'}
            </span>
          </span>
          <kbd className="hidden rounded-md border border-ink-700 px-1.5 font-mono text-[12px] text-ink-400 sm:inline">⌘K</kbd>
        </button>
      </header>
      {/* What needs the reader stays in view beside the sky: it scrolls on its own where the page fills the window, and sticks as the page scrolls elsewhere. */}
      <div className="min-w-0 space-y-10 xl:sticky xl:top-8 xl:col-start-2 xl:row-span-3 xl:row-start-1 xl:self-start xl:pt-2 desk:static desk:min-h-0 desk:self-stretch desk:overflow-y-auto desk:pr-2 desk:pb-8 desk:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]">
        {zen ? (
          <Folded tally={tallyOf(subject, theirAlerts)} elsewhere={elsewhere?.tally ?? null}>
            <NeedsList title={own ? 'Needs you' : 'Needs attention'} quiet={own ? 'Nothing of yours is failing or firing.' : 'Nothing is failing and nothing is firing.'} needs={needs} tally={tallyOf(subject, theirAlerts)} name={label} onLight={setLit} />
            {elsewhere && <Elsewhere at={othersAt} shown={others} onShown={setOthers} seesAll={view.seesAll} needs={elsewhere.needs} tally={elsewhere.tally} name={label} onLight={setLit} />}
          </Folded>
        ) : (
          <NeedsList title={own ? 'Needs you' : 'Needs attention'} quiet={own ? 'Nothing of yours is failing or firing.' : 'Nothing is failing and nothing is firing.'} needs={needs} tally={tallyOf(subject, theirAlerts)} name={label} onLight={setLit} />
        )}
        {own && <Yours mine={mine.data} byId={byId} name={label} onLight={setLit} />}
        {own && <ToFill name={label} />}
        {elsewhere && !zen && <Elsewhere at={othersAt} shown={others} onShown={setOthers} seesAll={view.seesAll} needs={elsewhere.needs} tally={elsewhere.tally} name={label} onLight={setLit} />}
      </div>
      <section aria-labelledby="sky" {...spot('now.sky')} className="relative min-w-0 xl:col-start-1 xl:row-start-2 desk:flex desk:min-h-[18rem] desk:flex-col">
        {/* The sky speaks for more than the verdict does, so it says so in its own heading: above it here, in its top corner where it fills the window. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink-800 pb-3 desk:pointer-events-none desk:absolute desk:top-0 desk:left-0 desk:z-10 desk:block desk:border-0 desk:pb-0">
          <h2 id="sky" className="text-lg font-semibold tracking-tight text-ink-50 desk:text-[15px]">
            {skyHeading}
          </h2>
          <span className="text-[13px] text-ink-400 tabular-nums desk:mt-0.5 desk:block desk:leading-relaxed">
            {plural(total, 'thing')}
            {failing > 0 && !zen && (
              <>
                <span className="desk:hidden">{' · '}</span>
                <span className="desk:block">
                  <span className="text-red">{failing.toLocaleString('en-US')} failing</span>
                  {own && (failingYours ? `, ${failingYours.toLocaleString('en-US')} yours` : ', none yours')}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="mx-auto mt-6 w-full max-w-[640px] desk:relative desk:mt-0 desk:min-h-0 desk:max-w-none desk:flex-1">
          <div className="desk:absolute desk:inset-0">
            <Sky areas={areas} total={total} whole={view.seesAll} yours={own ? mine.data.blueprints : null} level={areas.map((a) => a.level).reduce(worse, 'green')} selected={area?.name ?? null} onSelect={setPicked} lit={lit} links={links} fit={desk} ground={garden ? grounds : undefined} onLand={(kind) => navigate({ page: 'ground', blueprint: kind })} />
          </div>
        </div>
        <div className="mt-3 desk:mt-1">
          <Legend calm={zen} areas={areas} yours={!!own} ground={garden && !!grounds && Object.keys(grounds).length > 0} />
        </div>
      </section>
      {/* The chosen area's kinds, right under the sector they explain, in a list that scrolls inside itself. */}
      {area && <AreaKinds area={area} marks={zen ? [] : marks} byId={byId} yours={own ? mine.data.blueprints : null} grounds={garden ? grounds : undefined} onLight={setLit} className="xl:col-start-1 xl:row-start-3 desk:h-[clamp(11rem,24vh,20rem)]" />}
    </div>
  )
}

/** What is the reader's to fill in: the empty values an edit rule opens to them on their own things, most first. Nothing when there is none. */
function ToFill({ name }: { name: (id: string) => string }) {
  const fill = useMineFill(true).data?.fill ?? []
  if (!fill.length) return null
  return (
    <section aria-label="Yours to fill in" className="rounded-lg border border-ink-700 bg-ink-900/70 px-4 py-3">
      <h2 className="label">Yours to fill in</h2>
      <ul className="mt-1.5 space-y-1 text-[13px]">
        {fill.slice(0, 6).map((f) => (
          <li key={`${f.blueprint}:${f.field}`}>
            <Link to={{ page: 'inventory', blueprint: f.blueprint }} className="text-ink-200 hover:underline">
              <span className="text-ink-100">{name(f.blueprint)}</span>: {fillWords(f.count, f.title)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Whose things the page speaks for, in one quiet line under the verdict: the
 * reader's own, or why it is not, and what to do about it when they can.
 */
function Whose({ view, mine }: { view: Perspective; mine: MineResponse }) {
  const admin = useIsAdmin()
  const wide = view.seesAll ? 'everything in the estate' : 'everything shared with you'
  const kinds = Object.keys(mine.blueprints).length
  const line =
    view.because === null
      ? `${plural(mine.count, 'thing is', 'things are')} yours, in ${plural(kinds, 'kind')}.`
      : view.because === 'unset'
        ? `The catalog does not say yet what anyone owns, so this speaks for ${wide}.`
        : view.because === 'unknown'
          ? `The catalog has no person for your sign-in, so nothing here is marked yours. This speaks for ${wide}.`
          : `Nothing in the catalog is yours yet, so this speaks for ${wide}.`
  return (
    <span className="text-ink-300">
      {line}
      {view.because === 'unset' && admin && (
        <>
          {' '}
          <Link to={{ page: 'access' }} className="font-medium text-ink-100 underline decoration-ink-600 underline-offset-4 hover:decoration-ink-300">
            Say what a person owns
          </Link>
        </>
      )}
    </span>
  )
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')}\u00a0${n === 1 ? one : many}`

/** The ring the sky draws round what is the reader's: the one mark for "yours" wherever the page says it. */
function YoursMark({ className = 'size-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--color-orbit)" strokeWidth="2" />
    </svg>
  )
}

/**
 * The reader's own things, by kind, biggest first, green ones too; a kind
 * opens to list them, worst first, read only then. When the model says how
 * things are a person's, a row of roles narrows the list to one of them: what
 * they own, test, or run the platform of.
 */
function Yours({ mine, byId, name, onLight }: { mine: MineResponse; byId: Map<string, Blueprint>; name: (id: string) => string; onLight: (kind: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const heading = useId()
  const roles = ownRoles(mine)
  const kinds = ownKinds(mine, role)
  const shown = kinds.reduce((n, k) => n + k.count, 0)
  return (
    <section aria-labelledby={heading} className="min-w-0">
      <h2 id={heading} className="flex items-center gap-2 border-b border-ink-800 pb-3 text-lg font-semibold tracking-tight text-ink-50">
        <YoursMark />
        <span className="flex-1">Yours</span>
        <span className="text-[12px] font-normal text-ink-400 tabular-nums">{shown.toLocaleString('en-US')}</span>
      </h2>
      {roles.length > 1 && (
        <div role="group" aria-label="How they are yours" className="flex flex-wrap gap-1.5 pt-3">
          {[null, ...roles.map(([r]) => r)].map((r) => (
            <button key={r ?? ''} type="button" aria-pressed={role === r} onClick={() => setRole(r)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${role === r ? 'border-ink-300 text-ink-50' : 'border-ink-700 text-ink-300 hover:text-ink-100'}`}>
              {r ?? 'All'} <span className="tabular-nums text-ink-400">{(r ? roles.find(([x]) => x === r)![1] : mine.count).toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>
      )}
      <ul className="divide-y divide-ink-800/70">
        {kinds.map((k) => {
          const shut = open !== k.id
          return (
            <li key={k.id} onMouseEnter={() => onLight(k.id)} onMouseLeave={() => onLight(null)}>
              <button type="button" aria-expanded={!shut} onClick={() => setOpen(shut ? k.id : null)} className="flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-ink-900">
                {shut ? <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden /> : <ChevronDown className="size-4 shrink-0 text-ink-400" aria-hidden />}
                <BlueprintIcon bp={byId.get(k.id)} className="size-4 shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 break-words text-[14px] text-ink-100">{name(k.id)}</span>
                {k.level !== 'green' && <Lamp level={k.level} calm />}
                <span className="text-[13px] text-ink-300 tabular-nums">{k.count.toLocaleString('en-US')}</span>
              </button>
              {!shut && <OwnOfKind blueprint={k.id} role={role} showRoles={roles.length > 1} />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** One kind of the reader's own, opened: every one of them, worst first, read when it opens. One kind may hold thousands: the worst are listed and the rest counted. */
function OwnOfKind({ blueprint, role, showRoles }: { blueprint: string; role: string | null; showRoles: boolean }) {
  const kind = useMineKind(blueprint)
  const box = 'mb-2 ml-7 border-l border-ink-800 pl-3'
  if (kind.error) return <p className={`${box} py-1.5 text-[13px] text-ink-400`}>Could not read them. Open the list instead.</p>
  if (!kind.data) return <p className={`${box} py-1.5 text-[13px] text-ink-400`}>Loading…</p>
  const things = role ? kind.data.things.filter((t) => t.as.includes(role)) : kind.data.things
  const total = role ? (kind.data.blueprints[blueprint]?.as?.[role] ?? things.length) : kind.data.count
  return (
    <ul className={box}>
      {things.map((t) => (
        <li key={entityId(t.entity)}>
          <Link to={{ page: 'entity', ...t.entity }} className="flex items-center gap-2 py-1.5 text-[13px] text-ink-200 hover:text-ink-50">
            <Lamp level={t.level} calm />
            <span className="min-w-0 flex-1 break-words">{t.title}</span>
            {showRoles && t.as.length > 0 && <span className="shrink-0 text-[12px] text-ink-400">{t.as.join(', ')}</span>}
          </Link>
        </li>
      ))}
      {total > things.length && (
        <li>
          <Link to={{ page: 'inventory', blueprint }} className="block py-1.5 text-[13px] font-medium text-ink-200 hover:text-ink-50">
            {`The worst ${things.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}. Open the list`}
          </Link>
        </li>
      )}
    </ul>
  )
}

/**
 * What needs someone outside the reader's own, told apart so it never reads
 * as theirs: one line of counts, and the list when asked for.
 */
function Elsewhere({ at, shown, onShown, seesAll, needs, tally, name, onLight }: { at: Ref<HTMLElement>; shown: boolean; onShown: (shown: boolean) => void; seesAll: boolean; needs: Need[]; tally: Tally; name: (id: string) => string; onLight: (kind: string | null) => void }) {
  const heading = useId()
  const parts = [tally.failing ? `${tally.failing.toLocaleString('en-US')} failing` : '', tally.firing ? `${plural(tally.firing, 'alert')} firing` : '', tally.look ? `${tally.look.toLocaleString('en-US')} to look at` : ''].filter(Boolean)
  return (
    <section ref={at} aria-labelledby={heading} className="min-w-0 scroll-mt-6">
      <h2 id={heading} className="border-b border-ink-800 pb-3 text-[15px] font-semibold tracking-tight text-ink-200">
        {seesAll ? 'Elsewhere in the estate' : 'Elsewhere in what you can see'}
      </h2>
      <p className="mt-3 text-[13px] text-ink-300">{parts.length ? `${parts.join(', ')}. None of it is yours.` : 'Nothing else is failing or firing.'}</p>
      {needs.length > 0 && (
        <button type="button" aria-expanded={shown} onClick={() => onShown(!shown)} className="mt-1 py-1 text-[13px] font-medium text-ink-200 hover:text-ink-50">
          {shown ? 'Hide them' : 'Show them'}
        </button>
      )}
      {shown && <Stacks needs={needs} tally={tally} name={name} onLight={onLight} />}
    </section>
  )
}

/** What the sky's marks mean, and how many things each status holds, in one small row under it: size is how many, shape and colour the worst status. */
function Legend({ calm, areas, yours, ground }: { /** Zen mode: the legend leaves out the statuses, as the sky does. */ calm: boolean; areas: Area[]; /** Whether the sky marks the reader's own. */ yours: boolean; /** Whether any kind on the sky has a ground. */ ground: boolean }) {
  const things = areas.reduce((n, a) => n + a.count, 0)
  const off = areas.reduce((n, a) => ({ red: n.red + a.notGreen.red, amber: n.amber + a.notGreen.amber, grey: n.grey + a.notGreen.grey }), { red: 0, amber: 0, grey: 0 })
  const empty = areas.reduce((n, a) => n + a.kinds.filter((k) => !k.count).length, 0)
  const count = { green: things - off.red - off.amber - off.grey, amber: off.amber, red: off.red, grey: off.grey }
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] text-ink-400">
        {yours && (
          <span className="inline-flex items-center gap-1.5 font-medium text-orbit">
            <YoursMark />
            yours
          </span>
        )}
        {!calm && (['green', 'amber', 'red', 'grey'] as const).map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <Lamp level={l} />
            {l === 'grey' ? 'unknown' : LEVEL_NAME[l]}
            <span className="text-ink-300 tabular-nums">{count[l].toLocaleString('en-US')}</span>
          </span>
        ))}
      <span>Size is how many{empty > 0 ? `, ${empty} empty ${empty === 1 ? 'kind is a ring' : 'kinds are rings'}` : ''}</span>
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 20 8" className="h-2 w-5" aria-hidden>
          <path d="M1 7 Q10 -1 19 7" fill="none" stroke="var(--color-ink-500)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        joins the chosen area to others
      </span>
      {ground && (
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--color-ink-500)" strokeWidth="1.5" />
            <path d="M6 1.5 A4.5 4.5 0 0 1 10.5 6" fill="none" stroke="var(--color-signal-green)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          has a ground: the arc is the share inside every budget. Choose it to land
        </span>
      )}
    </p>
  )
}

/** The kinds of the area chosen on the sky, biggest first, each with a bar on a log scale, so 52 still shows beside 1,582. */
function AreaKinds({ area, marks, byId, yours, grounds, onLight, className = '' }: { area: Area; /** The area's failing kinds, as the sky numbers them. */ marks: Kind[]; byId: Map<string, Blueprint>; /** How many of each kind are the reader's, when the hub knows. */ yours: MineResponse['blueprints'] | null; /** The kinds that have a ground, when the reader may open one. */ grounds?: Record<string, GroundCover>; onLight: (id: string | null) => void; className?: string }) {
  const kinds = bySize(area)
  const zen = useZen()
  const most = Math.max(1, ...kinds.map((k) => k.count))
  const heading = useId()
  return (
    <section aria-labelledby={heading} aria-live="polite" className={`flex min-w-0 flex-col ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink-800 pb-3">
        <h2 id={heading} className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-50">
          {area.level !== 'green' && <Lamp level={area.level} calm />}
          {area.name}
        </h2>
        <span className="text-[13px] text-ink-400">
          {area.count.toLocaleString('en-US')} things in {area.kinds.length} {area.kinds.length === 1 ? 'kind' : 'kinds'}
        </span>
        <span className="ml-auto hidden text-[12px] text-ink-400 md:inline">{marks.length ? 'Choose another area on the sky. Numbers match its marks.' : 'Choose another area on the sky.'}</span>
      </div>
      <ul className="divide-y divide-ink-800/70 md:max-h-[28rem] md:overflow-y-auto md:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)] desk:max-h-none desk:min-h-0 desk:flex-1">
        {kinds.map((k) => (
          <li key={k.id} className="flex items-center gap-2" onMouseEnter={() => onLight(k.id)} onMouseLeave={() => onLight(null)}>
            <Link to={{ page: 'inventory', blueprint: k.id }} className="min-w-0 flex-1 grid grid-cols-[1.25rem_1.25rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 px-1 py-2 hover:bg-ink-900 sm:grid-cols-[1.25rem_1.25rem_minmax(0,1fr)_minmax(4rem,30%)_4.5rem]" title={byId.get(k.id)?.description}>
              {marks.includes(k) ? (
                <span className="grid size-5 place-items-center rounded-full border border-red text-[12px] font-semibold text-red tabular-nums" aria-hidden>
                  {marks.indexOf(k) + 1}
                </span>
              ) : (
                <span aria-hidden />
              )}
              <BlueprintIcon bp={byId.get(k.id)} className="size-4 text-ink-400" />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className={`min-w-0 [overflow-wrap:anywhere] text-[14px] ${k.count ? 'text-ink-100' : 'text-ink-400'}`}>{k.title}</span>
                {yours?.[k.id] && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-orbit tabular-nums">
                    <YoursMark className="size-2.5" />
                    {yours[k.id]!.count === k.count ? 'all yours' : `${yours[k.id]!.count.toLocaleString('en-US')} yours`}
                  </span>
                )}
                {k.level !== 'green' && !zen && (
                  <span className={`flex shrink-0 items-center gap-1.5 text-[12px] ${LEVEL_TEXT[k.level]}`}>
                    <Lamp level={k.level} />
                    {k.notGreen.red || k.notGreen.amber || k.notGreen.grey} {LEVEL_NAME[k.level]}
                  </span>
                )}
              </span>
              <span className="hidden h-1.5 rounded-full bg-ink-800 sm:block" aria-hidden>
                <span className="block h-full rounded-full bg-ink-400" style={{ width: k.count ? `${Math.max(3, (100 * Math.log10(k.count + 1)) / Math.log10(most + 1))}%` : 0 }} />
              </span>
              <span className={`text-right text-[13px] tabular-nums ${k.count ? 'text-ink-200' : 'text-ink-400'}`}>{k.count ? k.count.toLocaleString('en-US') : 'empty'}</span>
            </Link>
            {grounds?.[k.id] && (
              <Link to={{ page: 'ground', blueprint: k.id }} className="shrink-0 rounded-md border border-ink-700 px-2 py-1 text-[12px] font-medium text-ink-200 hover:bg-ink-800 hover:text-ink-50" title={coverText(grounds[k.id]!)}>
                Ground<span className="sr-only"> of {k.title}: {coverText(grounds[k.id]!)}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * What needs attention, in zen mode: one quiet line that says how much there
 * is, and opens to the lists Now shows outside zen.
 */
function Folded({ tally, elsewhere, children }: { tally: Tally; elsewhere: Tally | null; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const n = tally.failing + tally.firing + tally.look + (elsewhere ? elsewhere.failing + elsewhere.firing + elsewhere.look : 0)
  if (!n) return <p className="text-[13px] text-ink-400">Nothing to look at.</p>
  return (
    <section aria-label="To look at" className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg border border-ink-800 px-3 py-2.5 text-left text-[13px] text-ink-300 hover:border-ink-700 hover:text-ink-100">
        {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
        <span className="flex-1">{plural(n, 'thing')} to look at, when you are ready</span>
      </button>
      {open && <div className="mt-6 space-y-10">{children}</div>}
    </section>
  )
}

/** The three stacks, worst first: what is failing, what is firing, what wants a look. */
function Stacks({ needs, tally, name, onLight }: { needs: Need[]; tally: Tally; name: (blueprint: string) => string; onLight: (kind: string | null) => void }) {
  const stacks = [
    { id: 'failing', title: 'Failing', count: tally.failing, items: needs.filter((n) => n.kind === 'entity' && n.level === 'red') },
    { id: 'firing', title: 'Alerts firing', count: tally.firing, items: needs.filter((n) => n.kind === 'alert') },
    { id: 'look', title: 'To look at', count: tally.look, items: needs.filter((n) => n.kind === 'kind' || (n.kind === 'entity' && n.level !== 'red')) },
  ].filter((st) => st.items.length > 0)
  return (
    <>
      {stacks.map((st) => (
        <Stack key={st.id} title={st.title} count={st.count} items={st.items} name={name} onLight={onLight} />
      ))}
    </>
  )
}

function NeedsList({ title, quiet, needs, tally, name, onLight }: { title: string; quiet: string; needs: Need[]; tally: Tally; name: (blueprint: string) => string; onLight: (kind: string | null) => void }) {
  return (
    <section aria-labelledby="needs" {...spot('now.needs')} className="min-w-0">
      <h2 id="needs" className="border-b border-ink-800 pb-3 text-lg font-semibold tracking-tight text-ink-50">
        {title}
      </h2>
      {needs.length === 0 && <p className="py-6 text-sm text-ink-300">{quiet}</p>}
      <Stacks needs={needs} tally={tally} name={name} onLight={onLight} />
    </section>
  )
}

/** One stack of what needs a person: its name and count, its first few, and the rest when asked. */
function Stack({ title, count, items, name, onLight }: { title: string; count: number; items: Need[]; name: (blueprint: string) => string; onLight: (kind: string | null) => void }) {
  const [all, setAll] = useState(false)
  // A phone shows the worst two of each stack, so the sky is not far below the verdict.
  const first = useNarrow() ? 2 : FIRST
  return (
    <div className="mt-4">
      <h3 className="flex items-baseline justify-between text-[13px] font-medium text-ink-300">
        {title}
        <span className="text-[12px] text-ink-400 tabular-nums">{count.toLocaleString('en-US')}</span>
      </h3>
      <ul className="mt-1 divide-y divide-ink-800/70 border-y border-ink-800/70">
        {(all ? items : items.slice(0, first)).map((n) => (
          <li key={`${n.kind}:${n.title}:${n.entity?.key ?? ''}`} onMouseEnter={() => onLight(n.blueprint ?? n.entity?.blueprint ?? null)} onMouseLeave={() => onLight(null)}>
            <NeedRow need={n} name={name} />
          </li>
        ))}
      </ul>
      {items.length > first && (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="mt-1 block py-1 text-[13px] font-medium text-ink-200 hover:text-ink-50">
          {all ? 'Show fewer' : `Show ${items.length - first} more`}
        </button>
      )}
    </div>
  )
}

function NeedRow({ need, name }: { need: Need; name: (blueprint: string) => string }) {
  const to: Route | null = need.entity ? { page: 'entity', ...need.entity } : need.blueprint ? { page: 'inventory', blueprint: need.blueprint } : null
  const title = need.kind === 'kind' ? name(need.title) : need.title
  const on = need.kind === 'alert' && need.entity ? need.entity.key.split('/').pop() : null
  // A failing thing says what kind it is, so "Degraded" has a subject.
  const kind = need.kind === 'entity' && need.entity ? name(need.entity.blueprint) : null
  const body = (
    <>
      <Lamp level={need.level} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere] text-ink-50">{title}</span>
          {need.count > 1 && <span className="text-[13px] text-ink-400">{need.kind === 'kind' ? `${need.count} ${LEVEL_NAME[need.level]}` : `× ${need.count}`}</span>}
          {on && <span className="text-[13px] text-ink-400">on {on}{need.elsewhere > 0 ? ` and ${need.elsewhere} more ${need.elsewhere === 1 ? 'place' : 'places'}` : ''}</span>}
          {kind && <span className="text-[13px] text-ink-400">{kind}</span>}
        </span>
        {need.why && <span className="mt-0.5 line-clamp-2 block text-[13px] [overflow-wrap:anywhere] text-ink-300">{humanTimes(need.why)}</span>}
      </span>
      {need.since && <span className="shrink-0 pt-0.5 text-[12px] text-ink-400">{ago(need.since)}</span>}
    </>
  )
  const row = 'flex items-start gap-3 px-1 py-3'
  return to ? (
    <Link to={to} className={`${row} hover:bg-ink-900`}>
      {body}
    </Link>
  ) : (
    <div className={row}>{body}</div>
  )
}
