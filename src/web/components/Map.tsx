// The map: one thing that holds others seen as a planet you descend into, one
// grain a level. The planet shows where: each continent a place, each cell a
// garden (what one held thing has there) or a patch of its open ground, painted
// by its broken checks. What is tied to no place (things on none, and the
// checks that are a garden's own wherever it grows) lies apart from
// every continent, on the workshop's bench. A continent is a field of wheat,
// one bed a garden and one stalk a check of a thing there; a garden is its
// plants, each check a plant, grouped by what it asks. Every layer fills the
// window: the picture is the stage, and a panel beside it holds the verdict,
// one bar, one ranked list, and what the reader can do. A click on a thing
// opens a peek of it; a thing the reader may run an action on may also be
// ticked, to run one action on several. The page is part of the garden
// preview.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MapResponse } from '../../shared/api.ts'
import { byPlace, climbsOf, fixesOf, fronts, GROWTH, growthOf, inBloom, mendedBy, standingOf, tally, tendFirst, worse, type CheckTally, type Lifts, type MapClimb, type MapLadder, type MapMember, type MapPlot, type MapThing } from '../../shared/map.ts'
import type { StatusLevel } from '../../shared/model.ts'
import { benchOf, flowerOf, nearestOn, nowhereOf, openOn, type Box, PLANET, patchesOn, placeLabels, planetCoast, planetEdges, planetOf, pointsOf, type BenchCell, type Planet, type PlanetCell, type Point } from '../atlas.ts'
import { useBlueprintName, useMap, usePreview, useViewingAs, useWalk, useWalkChange, useWhoAmI } from '../api.ts'
import { checksText, counted, MAP_WORDS, WORDS, type MapWords } from '../ground.ts'
import { navigate, type Route } from '../router.ts'
import { Alarm, FlowerArt, LensPicker, NameText, checksLevel, Crumbs, textWidth, ofText, PanelHead, PeekCard, PeekChecks, Quiet, Ranked, ShapeIcon, Shell, SkyBand, StormEye, SvgLink, Tip, TipTitle, useSize, useTip, Verdict, WeatherDefs, type CoachStep, type KeyMark, type RankRow } from './Atlas.tsx'
import { AtlasSky } from './AtlasSky.tsx'
import { HandsTray, tickable, tickId, tickIds, useTicks } from './Hands.tsx'
import { Empty, ErrorNote, Link, useDesk, useNarrow } from './ui.tsx'
import { X } from 'lucide-react'
import { useHere } from '../trail.ts'
import { bloomsWith, climbText, liftsOf, progressOf, stepOf, stopOn } from '../walk.ts'
import type { WalkStep, WalkStepRequest } from '../../shared/api.ts'

interface MapAt {
  blueprint: string
  entityKey: string
  /** A place, null for what names no place, undefined for the whole planet. */
  at?: string | null
  plot?: string
  kind?: string
}

export function MapPage({ blueprint, entityKey, at, plot, kind }: { blueprint: string | null; entityKey: string | null; at?: string | null; plot?: string; kind?: string }) {
  const me = useWhoAmI()
  const open = usePreview('garden')
  if (!me.data) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  if (!open)
    return (
      <div className="py-12">
        <Empty>There is nothing at this address.</Empty>
      </div>
    )
  if (!blueprint || entityKey === null) return <AtlasSky />
  return <MapOf blueprint={blueprint} entityKey={entityKey} at={at} plot={plot} kind={kind} />
}

/**
 * What a click opened: one thing, or several that the picture draws as one
 * (a garden on a continent with what it runs there, a kind of open ground).
 * `to` leads deeper into the atlas, where there is somewhere deeper to go.
 */
interface Peeked {
  id: string
  kicker: string
  title: string
  /** Its status, where it is one thing or a place; none for a fix. */
  level?: StatusLevel
  reasons: string[]
  /** What its checks are read from. */
  things: MapThing[]
  /** The one entity it is, when it is one. */
  entity: MapThing | null
  /** What a tick takes: itself, or every thing drawn with it. */
  ticks: MapThing[]
  to?: { to: Route; label: string }
  /** A line under its status, such as how many things it stands for. */
  note?: string
  /** Things it names one by one, each opening its own peek, in place of how its checks stand. */
  items?: MapThing[]
  /** A garden's other sides: its own checks and each place it grows on, the one open marked `here`. */
  kin?: { says: string; here: boolean; open: () => Peeked }[]
}

/** Everything a layer of the map needs: the map, the weather picked, what is opened, and what is ticked. */
interface Ctx {
  m: MapResponse
  w: MapWords
  /** The ladder the lens asks about, by its id, and its title; null for every check. */
  front: string | null
  lensTitle: string | null
  setFront: (ladder: string | null) => void
  peeked: Peeked | null
  peek: (p: Peeked | null) => void
  ticked: ReadonlySet<string>
  /** Ticks or unticks those of some things the reader may run an action on. */
  tick: (things: readonly MapThing[], on: boolean) => void
  /** Whether the reader may run an action on anything on this map: only then is a tick box drawn anywhere. */
  canTick: boolean
  route: (to: Omit<MapAt, 'blueprint' | 'entityKey'>) => Route
  kindName: (blueprint: string) => string
  partName: (key: string) => string
  showTip: (e: { clientX: number; clientY: number }, body: ReactNode) => void
  hideTip: () => void
  /** The lens control over some things: every check, then each by name. The same on every layer. */
  lens: (things: readonly MapThing[]) => ReactNode
  /** The parts of the shell every layer shares: the way back up, the peek, and the tray. */
  crumbs: ReactNode
  peekCard: ReactNode
  tray: ReactNode
}

function MapOf({ blueprint, entityKey, at, plot, kind }: MapAt) {
  const map = useMap({ blueprint, key: entityKey })
  const [front, setFront] = useState<string | null>(null)
  const [ticked, tickSome, clear] = useTicks()
  const [peeked, peek] = useState<Peeked | null>(null)
  const [tip, showTip, hideTip] = useTip()
  const name = useBlueprintName()
  // A peek belongs to the layer it was opened on.
  useEffect(() => peek(null), [blueprint, entityKey, at, plot, kind])
  // The step is named by the deepest layer it opens: the planet, a place, a plot, or a kind of open ground.
  const md = map.data
  useHere(md && (at === undefined ? md.holder.title : kind ? name(kind) : plot ? (md.plots.find((p) => p.key === plot)?.title ?? plot) : at === null ? MAP_WORDS.unplaced : (md.places.find((p) => p.key === at)?.title ?? at)))
  if (map.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const m = map.data
  if (!m)
    return (
      <div className="py-12">
        <ErrorNote error={map.error ?? 'This map could not be read.'} />
      </div>
    )
  const w = MAP_WORDS
  const partTitle = new Map([m.holder, ...m.parts].map((p) => [p.key, p.title]))
  const things = new Map<string, MapThing>([...m.plots, ...m.members].map((t) => [tickId(t), t]))
  const chosen = [...ticked].flatMap((id) => things.get(id) ?? [])
  const placeTitle = (key: string | null) => (key === null ? w.unplaced : (m.places.find((p) => p.key === key)?.title ?? key))
  const route = (to: Omit<MapAt, 'blueprint' | 'entityKey'>): Route => ({ page: 'map', blueprint, key: entityKey, ...to })
  const steps: { label: string; kind?: string; to?: Route }[] = [
    { label: w.sky, to: { page: 'ground', blueprint: null } },
    { label: m.holder.title, kind: w.planet, to: route({}) },
  ]
  if (at !== undefined) steps.push({ label: placeTitle(at), kind: at === null ? undefined : w.place, to: route({ at }) })
  if (at !== undefined && plot) steps.push({ label: m.plots.find((p) => p.key === plot)?.title ?? plot, kind: w.plot })
  if (at !== undefined && kind) steps.push({ label: name(kind), kind: w.open })
  const canTick = tickable([...m.plots, ...m.members])
  const tick = (list: readonly MapThing[], on: boolean) => tickSome(tickIds(list), on)
  const peekTicks = peeked ? peeked.ticks.filter((t) => t.actions.length > 0) : []
  const ctx: Ctx = {
    m,
    w,
    front,
    lensTitle: front ? (m.ladders.find((l) => l.id === front)?.title ?? front) : null,
    setFront,
    peeked,
    peek,
    ticked,
    tick,
    canTick,
    route,
    kindName: name,
    // A part named after its holder is called by what follows the holder's name.
    partName: (key) => {
      const t = partTitle.get(key) ?? key
      return key !== m.holder.key && t.startsWith(`${m.holder.title}: `) ? t.slice(m.holder.title.length + 2) : t
    },
    showTip,
    hideTip,
    lens: (list) => <LensPicker options={fronts(list, m.ladders).map((f) => ({ id: f.ladder, title: f.title, broken: f.fail, nodata: f.unknown }))} picked={front} onPick={setFront} />,
    crumbs: (
      <>
        <Crumbs steps={steps} />
        {m.truncated.length > 0 && (
          <div className="mt-2">
            <ErrorNote error={`Read only the first entities of ${m.truncated.map(name).join(', ')}. The map leaves the rest out.`} />
          </div>
        )}
      </>
    ),
    peekCard: peeked && (
      <PeekCard
        kicker={peeked.kicker}
        title={peeked.title}
        level={peeked.level}
        reasons={peeked.reasons}
        entity={peeked.entity ?? undefined}
        open={peeked.to}
        links={peeked.entity?.links}
        tick={peekTicks.length ? { on: peekTicks.every((t) => ticked.has(tickId(t))), set: (on) => tick(peekTicks, on), label: peekTicks.length === 1 ? 'Tick it, to run one action on several' : `Tick its ${peekTicks.length.toLocaleString('en-US')} things you may act on` } : undefined}
        onClose={() => peek(null)}
      >
        {peeked.note && <p className="mt-1.5 text-[13px] text-ink-300">{peeked.note}</p>}
        {peeked.kin && (
          <nav aria-label={`This ${lower(w.plot)}, each side of it`} className="mt-2 flex flex-wrap gap-1.5">
            {peeked.kin.map((k) =>
              k.here ? (
                <span key={k.says} aria-current="true" className="inline-flex min-h-11 items-center rounded-full bg-ink-800 px-2.5 text-[12px] font-medium text-ink-50 ring-1 ring-[var(--color-orbit)] md:min-h-6">
                  {k.says}
                </span>
              ) : (
                <button key={k.says} type="button" onClick={() => peek(k.open())} className="inline-flex min-h-11 items-center rounded-full px-2.5 text-[12px] text-ink-200 ring-1 ring-ink-700 hover:bg-ink-850 hover:text-ink-50 md:min-h-6">
                  {k.says}
                </button>
              ),
            )}
          </nav>
        )}
        {peeked.items ? <p className="mt-2.5 text-[12px] font-medium text-red">Holds back {counted(peeked.items.length, 'thing')}</p> : <PeekChecks things={peeked.things} only={front} />}
        {peeked.items && (
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
            {peeked.items.map((x) => (
              <li key={tickId(x)}>
                <button type="button" onClick={() => peek(peekThing({ m, w, kindName: name }, x))} className="min-h-11 w-full rounded-md px-1.5 text-left text-[13px] break-words text-ink-100 underline-offset-4 hover:bg-ink-850 hover:underline md:min-h-7">
                  {x.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PeekCard>
    ),
    tray: <HandsTray chosen={chosen} noun={['thing', 'things']} onClear={clear} />,
  }
  return (
    <>
      {at === undefined ? <PlanetView ctx={ctx} /> : plot || kind ? <GardenView ctx={ctx} at={at} plot={plot ?? null} kind={kind ?? null} /> : <ContinentView ctx={ctx} at={at} />}
      <Tip tip={tip} />
    </>
  )
}

/** The name a peek of a garden on a place goes by, and of one kind of thing on open ground: a picture finds its opened cell by it. */
const patchId = (place: string | null, plot: string) => `patch:${place}:${plot}`
const kindId = (place: string | null, blueprint: string, part: string | null = null) => `kind:${place}:${blueprint}${part === null ? '' : `:${part}`}`

/** One thing as a peek opens it: what it is, where it lies, and the way deeper where it is a garden. */
function peekThing(ctx: Pick<Ctx, 'm' | 'w' | 'kindName'>, x: MapThing, to?: Peeked['to']): Peeked {
  const { m, w } = ctx
  const place = 'place' in x ? (x as MapMember).place : undefined
  const where = place === undefined ? '' : place === null ? ` in ${w.unplaced.toLowerCase()}` : ` on ${m.places.find((pl) => pl.key === place)?.title ?? place}`
  return { id: tickId(x), kicker: `${ctx.kindName(x.blueprint)}${where}`, title: x.title, level: x.level, reasons: x.reasons, things: [x], entity: x, ticks: [x], to }
}

/** A garden as a peek opens it: on a place, what it holds there; on the bench (`place` null), the garden itself, with the checks that are its own wherever it grows. */
function peekPatch(ctx: Ctx, plot: MapPlot, place: string | null, members: MapThing[], level: StatusLevel): Peeked {
  const { m, w } = ctx
  const title = place === null ? w.unplaced : (m.places.find((pl) => pl.key === place)?.title ?? place)
  const placeTitle = (key: string) => m.places.find((pl) => pl.key === key)?.title ?? key
  // One garden, seen from each side: its own checks on the bench, and what it holds on each place it grows on.
  const kin = [
    { says: 'Its own checks', here: place === null, open: () => peekPatch(ctx, plot, null, [], plot.level) },
    ...plot.at.map((a) => ({ says: placeTitle(a.place), here: place === a.place, open: () => peekPatch(ctx, plot, a.place, m.members.filter((x) => x.plot === plot.key && x.place === a.place), a.level) })),
  ]
  return {
    id: patchId(place, plot.key),
    kicker: place === null ? `${ctx.kindName(plot.blueprint)}, its own checks` : `${w.plot} on ${title}`,
    title: plot.title,
    level,
    reasons: plot.reasons,
    things: place === null ? [plot] : members,
    entity: plot,
    ticks: place === null ? [plot] : [plot, ...members],
    to: { to: ctx.route({ at: place, plot: plot.key }), label: place === null ? 'Open its own checks' : `Open the ${w.plot.toLowerCase()}` },
    note: place === null ? (plot.at.length ? undefined : `On no ${w.place.toLowerCase()} yet`) : `${counted(members.length, 'thing')} here`,
    kin: kin.length > 1 ? kin : undefined,
  }
}

/** One kind of thing on open ground, as a peek opens it: all of it there, or with `part`, one part's share of it. */
function peekKind(ctx: Ctx, place: string | null, blueprint: string, things: MapThing[], part: string | null = null): Peeked {
  const { m, w } = ctx
  const title = place === null ? w.unplaced : (m.places.find((pl) => pl.key === place)?.title ?? place)
  return {
    id: kindId(place, blueprint, part),
    kicker: [place === null ? `In ${title.toLowerCase()}` : `${w.open} on ${title}`, ...(part === null || part === m.holder.key ? [] : [m.parts.find((x) => x.key === part)?.title ?? part])].join(' · '),
    title: ctx.kindName(blueprint),
    level: things.map((x) => x.level).reduce<StatusLevel>(worse, 'grey'),
    reasons: [],
    things,
    entity: null,
    ticks: things,
    to: { to: ctx.route({ at: place, kind: blueprint }), label: 'Open them' },
    note: counted(things.length, 'thing'),
  }
}

const bandWords = (w: MapWords) => ({
  holding: w.holding,
  broken: w.broken,
  nodata: w.nodata,
})
const lower = (s: string) => s.toLowerCase()
/** Names as a sentence lists them: "Prod", "Prod and Test", "Prod, Test, and Dev". */
const listOf = (names: readonly string[]) => new Intl.ListFormat('en-US', { type: 'conjunction' }).format(names)
const n = (v: number) => v.toLocaleString('en-US')

// The planet ---------------------------------------------------------------------

/** The place a plot has the most broken checks on, which opening it from afar lands on; null when it runs nowhere. */
function worstPlaceOf(m: MapResponse, plot: MapPlot, front: string | null): string | null {
  let best: string | null = null
  let most = -1
  for (const a of plot.at) {
    const f = tally(
      m.members.filter((x) => x.plot === plot.key && x.place === a.place),
      front,
    ).fail
    if (f > most) {
      most = f
      best = a.place
    }
  }
  return best
}

const STARS: [number, number, number, number][] = (() => {
  let x = 3
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647
  return Array.from({ length: 300 }, () => [rnd() * 2400 - 700, rnd() * 2400 - 700, 0.4 + rnd() * 1.1, 0.15 + rnd() * 0.35])
})()

/** Text in a picture at a size in screen pixels, whatever the picture is scaled to. */
const px = (size: number, scale: number) => size / Math.max(0.2, scale)

/** The things a lens's ladder is broken on. */
const brokenUnder = (all: readonly MapThing[], ladder: string) => all.filter((x) => x.checks.some((c) => c.ladder === ladder && c.state === 'fail'))

/** How some checks stand, said as a hover card says it: "5 of 20 checks broken". */
const saysOf = (t: CheckTally): string => {
  const all = t.pass + t.fail + t.unknown
  if (!all) return 'nothing checks it'
  if (t.fail) return `${n(t.fail)} of ${n(all)} checks broken`
  return t.unknown ? `${n(t.unknown)} of ${n(all)} checks have no data` : `all ${n(all)} checks hold`
}

/** How a cell of land is painted by its checks: three steps of broken, then fog for no data, green for holding, and bare ground where nothing checks. */
const cellFill = (t: CheckTally, uid: string): string => {
  if (t.fail) return t.fail * 2 >= t.fail + t.pass + t.unknown ? 'var(--color-atlas-cell-fail)' : 'var(--color-atlas-cell-some)'
  if (t.unknown) return `url(#${uid}-fogcell)`
  return t.pass ? 'var(--color-atlas-cell-pass)' : `url(#${uid}-bare)`
}

/** The map's first visit, in three steps: the planet's, and every layer under it. */
const MAP_TOUR: CoachStep[] = [
  { at: 'stage', title: 'Land you tend', says: 'A planet is one thing and all it holds, a continent a place its things are. On a continent each flower is a garden there or a kind of thing, a petal for each scorecard: full and green at the top, short and red where a check is broken.' },
  { at: 'panel', title: 'Click anything to peek', says: 'Its checks open here. Under the meadow, the walk ranks the climbs that mend the most: add a stop and it waits for you here, on every device.' },
  { at: 'over', title: 'Ask one thing at a time', says: 'The lens redraws every layer for one scorecard alone. The ? holds the key.' },
]

/** One row of what to tend first on the planet: a garden over every continent, or a kind of open ground on one. `glow` names its cells on the globe. */
interface Tended {
  id: string
  glow: string
  title: string
  t: CheckTally
  ticks: MapThing[]
  peek: Peeked
}

function PlanetView({ ctx }: { ctx: Ctx }) {
  const { m, w, front } = ctx
  const planet = useMemo(() => planetOf(m), [m])
  // What a row of the panel points at: a place (`place:<key>`), the workshop (`bench`), or a garden or patch of Tend first.
  const [lit, setLit] = useState<string | null>(null)
  // The part picked, or pointed at, on the Parts control: its ground is outlined and the rest stands back.
  const [part, setPart] = useState<string | null>(null)
  const [partAt, setPartAt] = useState<string | null>(null)
  const all = [...m.plots, ...m.members]
  const t = tally(all, front)
  // Where the broken checks are, each once: the things on each place, and everything tied to none.
  const where = byPlace(m, front)
    .map(({ place, t: y }) => ({ place, y, title: place === null ? w.unplaced : (m.places.find((p) => p.key === place)?.title ?? place) }))
    .sort((a, b) => b.y.fail - a.y.fail || b.y.unknown - a.y.unknown || a.title.localeCompare(b.title))
  const worst = where.find((x) => x.y.fail > 0)
  // On a phone the worst continent's field follows the lists, so the first scroll already shows what is broken there.
  const narrow = useNarrow()
  const worstLand = where.find((x) => x.y.fail > 0 && x.place !== null)
  // What to tend first, gardens and patches of open ground together: a garden summed over every continent it runs on, a patch on its one continent.
  const tend: Tended[] = [
    ...tendFirst(m, 50, front).map((g): Tended => {
      const ticks = [g.plot, ...g.members]
      return {
        id: g.plot.key,
        glow: g.plot.key,
        title: g.plot.title,
        t: g,
        ticks,
        peek: { id: `tend:${g.plot.key}`, kicker: `${w.plot}, everywhere it runs`, title: g.plot.title, level: g.plot.level, reasons: g.plot.reasons, things: ticks, entity: g.plot, ticks, to: { to: ctx.route({ at: worstPlaceOf(m, g.plot, front), plot: g.plot.key }), label: `Open the ${lower(w.plot)}` }, note: counted(g.members.length, 'thing') },
      }
    }),
    ...m.places.flatMap((pl) =>
      openOn(m, pl.key).map(
        (o): Tended => ({ id: `open:${pl.key}:${o.blueprint}`, glow: `open:${pl.key}:${o.blueprint}`, title: `${ctx.kindName(o.blueprint)} on ${pl.title}`, t: tally(o.members, front), ticks: o.members, peek: peekKind(ctx, pl.key, o.blueprint, o.members) }),
      ),
    ),
  ]
    .filter((x) => x.t.fail > 0)
    .sort((a, b) => b.t.fail - a.t.fail || b.t.pass + b.t.fail + b.t.unknown - (a.t.pass + a.t.fail + a.t.unknown) || a.title.localeCompare(b.title))
    .slice(0, 20)
  const stage = (
    <figure className="m-0 desk:absolute desk:inset-0">
      <PlanetArt ctx={ctx} planet={planet} lit={lit} part={partAt ?? part} />
      <figcaption className="sr-only">
        {m.holder.title} as a {lower(w.planet)}. {where.map((x) => `${x.title}: ${checksText(x.y.fail, x.y.unknown)}`).join('. ')}.
      </figcaption>
    </figure>
  )
  // What to do across the whole planet: each fix once, the one that holds back the most things first.
  const fixes = fixesOf(all, front)
  const tendable = tend
    .slice(0, 5)
    .flatMap((g) => g.ticks)
    .filter((x) => x.actions.length > 0)
  const lensTicks = front ? brokenUnder(all, front).filter((x) => x.actions.length > 0) : []
  const parts = m.parts.map((p) => ({ p, y: tally([...m.plots.filter((x) => x.part === p.key), ...m.members.filter((x) => x.part === p.key)], front) }))
  const panel = (
    <>
      <Verdict kicker={`${w.planet}${ctx.lensTitle ? ` · ${ctx.lensTitle}` : ''}`}>
        {m.holder.title}: {t.fail ? <Alarm>{n(t.fail)}</Alarm> : 'nothing'} broken
        {worst ? (
          <Quiet>
            , the most {worst.place === null ? 'in' : 'on'} {worst.place === null ? lower(worst.title) : worst.title} ({n(worst.y.fail)}).
          </Quiet>
        ) : t.unknown ? (
          <Quiet>, {n(t.unknown)} not judged.</Quiet>
        ) : (
          '.'
        )}
      </Verdict>
      <SkyBand t={t} words={bandWords(w)} className="mt-5" />
      <section>
        <PanelHead title="Where" />
        <Ranked
          label="Where the broken checks are"
          rows={where.map((x) => ({
            id: x.place ?? '',
            title: x.title,
            says: `${n(x.y.fail)} broken of ${n(x.y.pass + x.y.fail + x.y.unknown)}`,
            broken: x.y.fail,
            to: ctx.route({ at: x.place }),
            picked: lit === (x.place === null ? 'bench' : `place:${x.place}`),
            onPoint: (on) => setLit(on ? (x.place === null ? 'bench' : `place:${x.place}`) : null),
          }))}
        />
      </section>
      {fixes.length > 0 && (
        <section>
          <PanelHead title="Fix first" />
          <Ranked
            label="Fix first"
            first={5}
            rows={fixes.map((f) => {
              const id = `fix:${f.title}\0${f.fix}`
              const opened: Peeked = { id, kicker: f.level ? `To fix, for ${f.level}` : 'To fix', title: f.title, reasons: [], things: f.things, entity: null, ticks: f.things, note: f.fix, items: f.things }
              return {
                id,
                title: f.title,
                says: counted(f.things.length, 'thing'),
                broken: f.things.length,
                picked: ctx.peeked?.id === id,
                onPick: () => ctx.peek(ctx.peeked?.id === id ? null : opened),
                onPoint: (on) => setLit(on ? id : null),
              }
            })}
          />
        </section>
      )}
      {tend.length > 0 && (
        <section>
          <PanelHead title={w.tend} />
          <Ranked
            label={w.tend}
            first={5}
            rows={tend.map((g) => {
              const mine = g.ticks.filter((x) => x.actions.length > 0)
              return {
                id: g.id,
                title: g.title,
                says: `${n(g.t.fail)} broken of ${n(g.t.pass + g.t.fail + g.t.unknown)}`,
                broken: g.t.fail,
                picked: ctx.peeked?.id === g.peek.id,
                onPick: () => ctx.peek(ctx.peeked?.id === g.peek.id ? null : g.peek),
                onPoint: (on) => setLit(on ? g.glow : null),
                after:
                  mine.length > 0 ? (
                    <label className="inline-flex size-11 shrink-0 items-center justify-center md:size-8">
                      <input type="checkbox" className="size-4" aria-label={`Tick ${g.title}`} checked={mine.every((x) => ctx.ticked.has(tickId(x)))} onChange={(e) => ctx.tick(mine, e.target.checked)} />
                    </label>
                  ) : undefined,
              }
            })}
          />
        </section>
      )}
      {narrow && worstLand && (
        <section>
          <PanelHead title={worstLand.title}>
            <Link to={ctx.route({ at: worstLand.place })} className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-ink-200 underline underline-offset-4">
              Open
            </Link>
          </PanelHead>
          <Meadow ctx={ctx} beds={bedsOf(ctx, worstLand.place)} lifts={() => false} opens />
        </section>
      )}
      {parts.length > 0 && (
        <section>
          <PanelHead title={w.parts} />
          <ul className="flex flex-wrap gap-1.5" onPointerLeave={() => setPartAt(null)}>
            {parts.map(({ p, y }) => (
              <li key={p.key}>
                <button type="button" aria-pressed={part === p.key} onClick={() => setPart(part === p.key ? null : p.key)} onPointerEnter={() => setPartAt(p.key)} onFocus={() => setPartAt(p.key)} onBlur={() => setPartAt(null)} className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-left text-[13px] md:min-h-8 ${part === p.key ? 'border-orbit bg-ink-850 text-ink-50' : 'border-ink-700 text-ink-200 hover:border-ink-500'}`}>
                  {ctx.partName(p.key)}
                  <span className={y.fail ? 'text-red tabular-nums' : 'text-ink-300 tabular-nums'}>{n(y.fail)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(tendable.length > 0 || lensTicks.length > 0) && (
        <section>
          <PanelHead title={WORDS.hands} />
          <div className="flex flex-wrap gap-2">
            {tendable.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(tendable, true)}>
                Tick the first {n(Math.min(5, tend.length))}
              </button>
            )}
            {lensTicks.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(lensTicks, true)}>
                Tick the {n(lensTicks.length)} it breaks on
              </button>
            )}
          </div>
        </section>
      )}
    </>
  )
  return <Shell crumbs={ctx.crumbs} stage={stage} over={ctx.lens(all)} panel={panel} peek={ctx.peekCard} tray={ctx.tray} legend={planetKey(w)} keyAt="right" tour={{ id: 'map', steps: MAP_TOUR }} />
}

/** The planet's key, in its own marks: what a cell's colour says, and the two kinds of cell. */
function planetKey(w: MapWords): KeyMark[] {
  const cell = (style: React.CSSProperties) => <i aria-hidden className="inline-block size-3.5 rounded-[3px]" style={style} />
  return [
    { mark: cell({ background: 'var(--color-atlas-cell-fail)' }), word: 'half broken', says: 'Red: half or more of its checks are broken.' },
    { mark: cell({ background: 'var(--color-atlas-cell-some)' }), word: 'some', says: 'Dark red: some of its checks are broken.' },
    { mark: cell({ background: 'repeating-linear-gradient(-45deg, var(--color-atlas-fog) 0 2px, var(--color-atlas-bare) 2px 5px)' }), word: 'no data', says: 'Hatched: nothing broken, and some checks have no data. It is never read as holding.' },
    { mark: cell({ background: 'var(--color-atlas-cell-pass)' }), word: 'holding', says: 'Green: every check holds.' },
    { mark: cell({ background: 'transparent', outline: '2px solid var(--color-atlas-hedge)', outlineOffset: '-2px' }), word: lower(w.plot), says: `A hedged cell is a ${lower(w.plot)}: what it holds on that ${lower(w.place)}. Pointing at one joins its copies on the others.` },
    { mark: cell({ background: 'transparent', outline: '1.5px dashed var(--color-atlas-coast)', outlineOffset: '-2px' }), word: w.patch, says: `A dashed cell is a ${w.patch} of open ground: one kind of thing there that no ${lower(w.plot)} claims.` },
    { mark: <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink-950 px-1 text-[12px] font-semibold text-ink-50 ring-2 ring-red">9</span>, word: 'broken', says: `The number on a ${lower(w.place)} is its broken checks. The bench beside the globe is ${lower(w.unplaced)}. A hedged square there is a ${lower(w.plot)}'s own checks, the same wherever it grows; pointing at one lights it on every ${lower(w.place)}. A dashed square is a kind of thing on no ${lower(w.place)}.` },
  ]
}

/**
 * The land of the planet, each cell painted as the checks of what sits there
 * stand. A garden's cell keeps a hedge round it; a patch of open ground a
 * dashed edge. Drawn once a map and a lens.
 */
const Land = memo(function Land({ planet, uid, front }: { planet: Planet; uid: string; front: string | null }) {
  const coast = useMemo(() => planetCoast(planet), [planet])
  return (
    <>
      <path d={coast} fill="none" stroke="var(--color-atlas-shallows)" strokeWidth={9} strokeOpacity={0.5} filter={`url(#${uid}-soft)`} />
      <g>
        {planet.cells.map((c, i) => (
          <polygon key={i} data-cell={i} className="atlas-cell" points={pointsOf(c.poly)} fill={cellFill(tally(c.here, front), uid)} stroke={c.patch ? 'var(--color-atlas-hedge)' : 'var(--color-atlas-coast)'} strokeOpacity={c.patch ? 1 : 0.7} strokeWidth={c.patch ? 1.8 : 1.2} strokeDasharray={c.patch ? undefined : '3 3'} />
        ))}
      </g>
      <path d={coast} fill="none" stroke="var(--color-atlas-coast)" strokeOpacity={0.6} strokeWidth={1.1} pointerEvents="none" />
    </>
  )
})

function PlanetArt({ ctx, planet, lit, part }: { ctx: Ctx; planet: Planet; lit: string | null; part: string | null }) {
  const { m, w, front } = ctx
  const [ref, width, height] = useSize<HTMLDivElement>()
  const desk = useDesk()
  const [hover, setHover] = useState<number | null>(null)
  const [benchHover, setBenchHover] = useState<number | null>(null)
  // The cell a keyboard reader stands on: the globe is one tab stop, and the arrows walk from cell to cell.
  const [stood, setStood] = useState<number | null>(null)
  const uid = 'planet'
  const { C, R } = PLANET
  // On a phone the picture is cropped to the globe and a band above and below it for names, so the globe takes the screen's width.
  const narrow = !desk && width > 0 && width < 600
  // On a desk the picture is as wide or as tall as its stage, the globe's square at its middle, so the sky fills the stage and names have the room beside the globe.
  const aspect = desk && width && height ? Math.min(2.2, Math.max(0.5, width / height)) : 1
  const view = narrow ? { x: 120, y: 10, w: 760, h: 1160 } : aspect >= 1 ? { x: C - C * aspect, y: 0, w: PLANET.side * aspect, h: PLANET.side } : { x: 0, y: C - C / aspect, w: PLANET.side, h: PLANET.side / aspect }
  const scale = (width || 600) / view.w
  // The workshop: what is tied to no place, on a bench of its own apart from the globe, at the picture's lower left; under the globe on a phone.
  const benchW = narrow ? 300 : 190
  const bench = useMemo(() => benchOf(m, benchW, narrow ? 90 : 110), [m, benchW, narrow])
  const nowhere = nowhereOf(m)
  const benchT = tally([...nowhere.plots, ...nowhere.members], front)
  const benchWords = `${n(benchT.fail)} broken`
  const benchText = Math.max(textWidth(w.unplaced, 17, 400), textWidth(benchWords, 13, 400)) / Math.max(0.2, scale)
  const benchAt: Point = narrow ? [C - benchW / 2, C + R + 44] : [view.x + px(18, scale), view.y + view.h - px(18, scale) - px(46, scale) - bench.h]
  const benchBox: Box = { x: benchAt[0] - 4, y: benchAt[1] - 4, w: Math.max(benchW, benchText) + 8, h: bench.h + px(46, scale) + 8 }
  // The key sits in the picture's lower right on a desk: no name goes under it.
  const keyBox: Box = { x: view.x + view.w - (desk ? px(470, scale) : 0), y: view.y + view.h - (desk ? px(48, scale) : 0), w: desk ? px(470, scale) : 0, h: desk ? px(48, scale) : 0 }
  // And the lens floats in its upper left.
  const lensBox: Box = { x: view.x, y: view.y, w: desk ? px(470, scale) : 0, h: desk ? px(62, scale) : 0 }
  const placeOf = (c: PlanetCell) => planet.lands[c.land]!.place
  // The hover card reads the cell aloud: what it is, where, and how its checks stand.
  const tipOf = (c: PlanetCell): ReactNode => {
    const place = placeOf(c)
    const here = tally(c.here, front)
    if (c.patch) {
      const also = c.patch.plot.at.filter((a) => a.place !== place.key).map((a) => m.places.find((p) => p.key === a.place)?.title ?? a.place)
      return (
        <>
          <TipTitle>{c.patch.plot.title}</TipTitle>
          {w.plot} on {place.title}: {saysOf(here)}.
          <span className="block text-ink-300">{[counted(c.patch.members.length, 'thing'), also.length ? `also on ${also.join(', ')}` : ''].filter(Boolean).join(' · ')}</span>
        </>
      )
    }
    return (
      <>
        <TipTitle>
          {ctx.kindName(c.open!.blueprint)} on {place.title}
        </TipTitle>
        {w.open}: {saysOf(here)}.<span className="block text-ink-300">{[counted(c.open!.members.length, 'thing'), ...(c.part === m.holder.key ? [] : [m.parts.find((x) => x.key === c.part)?.title ?? c.part])].join(' · ')}</span>
      </>
    )
  }
  const cellAt = (e: React.PointerEvent | React.MouseEvent) => {
    const i = (e.target as Element).getAttribute?.('data-cell')
    return i === null || i === undefined ? null : Number(i)
  }
  const deeper = (c: PlanetCell) => ctx.route(c.patch ? { at: placeOf(c).key, plot: c.patch.plot.key } : { at: placeOf(c).key, kind: c.open!.blueprint })
  // A click opens a peek of the cell: a garden where it runs here, or one kind of thing on the open ground.
  const peekOf = (c: PlanetCell) => (c.patch ? peekPatch(ctx, c.patch.plot, placeOf(c).key, c.patch.members, c.patch.level) : peekKind(ctx, placeOf(c).key, c.open!.blueprint, c.open!.members, c.part))
  // The cell a step of the arrow keys lands on: the nearest one that way, a cell off to the side counting as further.
  const step = (from: number, dx: number, dy: number): number => {
    const a = planet.cells[from]!
    let best = from
    let least = Infinity
    planet.cells.forEach((c, i) => {
      const along = (c.x - a.x) * dx + (c.y - a.y) * dy
      if (i === from || along <= 1) return
      const far = along + Math.abs((c.x - a.x) * dy - (c.y - a.y) * dx) * 2.5
      if (far < least) {
        least = far
        best = i
      }
    })
    return best
  }
  const onKey = (e: React.KeyboardEvent) => {
    const at = stood ?? 0
    const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (move[e.key]) {
      e.preventDefault()
      setStood(step(at, ...move[e.key]!))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const c = planet.cells[at]
      if (c) ctx.peek(peekOf(c))
    }
  }
  const standing = stood !== null ? planet.cells[stood] : undefined
  const spoken = (c: PlanetCell) => `${c.patch ? `${c.patch.plot.title}, ${lower(w.plot)}` : `${ctx.kindName(c.open!.blueprint)}, ${lower(w.open)}`} on ${placeOf(c).title}: ${saysOf(tally(c.here, front))}`
  // The copies of the hovered garden on its other places, outlined and joined by arcs.
  const hovered = hover !== null ? planet.cells[hover] : undefined
  const copies = hovered?.patch ? planet.cells.filter((o) => o.patch?.plot === hovered.patch!.plot) : []
  // The cell the open peek is of stays marked, and its garden stays joined to its copies, until the peek closes.
  const opened = ctx.peeked
  const picked = opened ? planet.cells.find((c) => (c.patch ? patchId(placeOf(c).key, c.patch.plot.key) : kindId(placeOf(c).key, c.open!.blueprint, c.part)) === opened.id) : undefined
  const pickedCopies = opened?.entity ? planet.cells.filter((o) => o.patch?.plot.key === opened.entity!.key && o.patch.plot.blueprint === opened.entity!.blueprint) : []
  // A garden's own square on the bench picks the same garden: picked or pointed at there, its copies on the globe light and join one another, and no line runs to the bench.
  const onBench = (key: string, blueprint: string) => bench.cells.find((c) => c.plot?.key === key && c.plot.blueprint === blueprint)
  const pickedBench = opened?.entity ? onBench(opened.entity.key, opened.entity.blueprint) : undefined
  const benchHovered = benchHover !== null ? bench.cells[benchHover] : undefined
  const benchCopies = benchHovered?.plot ? planet.cells.filter((o) => o.patch?.plot.key === benchHovered.plot!.key && o.patch.plot.blueprint === benchHovered.plot!.blueprint) : []
  const at = (c: PlanetCell): Point => [c.x, c.y]
  // An arc from one point to each of the others, bowed away from the globe's middle.
  const arcs = (from: Point, to: Point[], colour: string, bold = false) =>
    to
      .filter((o) => o[0] !== from[0] || o[1] !== from[1])
      .map((o, i) => {
        const mx = (from[0] + o[0]) / 2
        const my = (from[1] + o[1]) / 2
        const dl = Math.hypot(mx - C, my - C) || 1
        return <path key={i} d={`M${from[0]} ${from[1]}Q${mx + ((mx - C) / dl) * 90} ${my + ((my - C) / dl) * 90} ${o[0]} ${o[1]}`} fill="none" stroke={colour} strokeOpacity={bold ? 1 : 0.85} strokeWidth={bold ? 2.4 : 1.6} strokeDasharray={bold ? '6 4' : '4 4'} strokeLinecap="round" />
      })
  // Each land's one mark: its name over the eye of its storm, the count of its broken checks, at the middle of where they are. It sits on the land itself, so no name waits on room round the globe.
  const eyeText = px(13, scale)
  const eyeR = (f: number) => Math.max(px(Math.min(22, 10 + Math.sqrt(f) * 0.35), scale), (textWidth(f.toLocaleString('en-US'), 13, 600) / 2 + 7) / Math.max(0.2, scale))
  const labels = planet.lands.map((l) => {
    const y = tally(
      l.cells.flatMap((c) => c.here),
      front,
    )
    const size = scale < 0.55 ? 17 : 24
    const big = px(size, scale)
    const wide = (textWidth(l.place.title, size, 400) * 0.82) / Math.max(0.2, scale) + px(10, scale)
    const fail = l.cells.reduce((k, c) => k + tally(c.here, front).fail, 0)
    const eye: Point | null = fail ? [l.cells.reduce((k, c) => k + c.x * tally(c.here, front).fail, 0) / fail, l.cells.reduce((k, c) => k + c.y * tally(c.here, front).fail, 0) / fail] : null
    const at: Point = eye ?? [l.middle[0], l.middle[1]]
    const r = eye ? eyeR(y.fail) : 0
    // The name over the count, as one block centred on the mark's middle.
    const tall = big * 1.2
    const block: Box = { x: at[0] - wide / 2, y: at[1] - r - px(4, scale) - tall, w: wide, h: tall + (eye ? 2 * r + px(4, scale) : 0) }
    // A land is big enough for its mark when the block lies on its own cells: every corner within a cell's reach of one of them.
    const reach = (Math.hypot(l.cells[0]!.poly[0]![0] - l.cells[0]!.x, l.cells[0]!.poly[0]![1] - l.cells[0]!.y) || 12) * 1.6
    const fits = [
      [block.x, block.y],
      [block.x + block.w, block.y],
      [block.x, block.y + block.h],
      [block.x + block.w, block.y + block.h],
    ].every(([cx, cy]) => l.cells.some((c) => Math.hypot(c.x - cx!, c.y - cy!) <= reach))
    return { l, y, big, wide, tall, eye, at, r, block, fits, bottom: Math.max(...l.cells.map((c) => c.y)) }
  })
  // A land too small for its mark keeps its name outside it, on a line back: above it, below it, or in the sky round the globe. One that finds no room there is named on its land all the same, so every land is named.
  const outside = (() => {
    const small = labels.map((lb, i) => ({ lb, i })).filter(({ lb }) => !lb.fits)
    const boxes = small.map(({ lb }) => {
      const cx = lb.l.middle[0] - lb.wide / 2
      const band = (y: number): Box => ({ x: Math.min(view.x + view.w - lb.wide - 4, Math.max(view.x + 4, cx)), y, w: lb.wide, h: lb.tall })
      const side = (left: boolean, dy: number): Box => ({ x: left ? C - R - lb.wide - px(8, scale) : C + R + px(8, scale), y: lb.l.middle[1] - lb.tall / 2 + dy, w: lb.wide, h: lb.tall })
      const left = lb.l.middle[0] < C
      return [
        { x: cx, y: lb.l.top - lb.tall - px(6, scale), w: lb.wide, h: lb.tall },
        { x: cx, y: lb.bottom + px(8, scale), w: lb.wide, h: lb.tall },
        side(left, 0),
        side(left, -lb.tall),
        side(left, lb.tall),
        band(C + R + px(10, scale)),
        band(C - R - lb.tall - px(10, scale)),
        side(!left, 0),
      ]
    })
    // Everything already on the picture keeps these names off it: every land's cells but its own, each eye, each name on its land, the bench, the key, and the lens.
    const lands = small.flatMap(({ i }, k) => planet.lands.flatMap((l, li) => l.cells.map((c) => ({ x: c.x - 9, y: c.y - 9, w: 18, h: 18, ...(li === i ? { owner: k } : {}) }))))
    const eyes: Box[] = labels.flatMap((lb) => (lb.eye ? [{ x: lb.eye[0] - lb.r - px(6, scale), y: lb.eye[1] - lb.r - px(6, scale), w: 2 * (lb.r + px(6, scale)), h: 2 * (lb.r + px(6, scale)) }] : []))
    const onLand = labels.filter((lb) => lb.fits).map((lb) => lb.block)
    const chosen = placeLabels(boxes, [...lands, ...eyes, ...onLand, benchBox, keyBox, lensBox], px(6, scale), view)
    return new Map(small.map(({ i }, k) => [i, chosen[k] ?? null]))
  })()
  const benchCell = (e: React.PointerEvent | React.MouseEvent) => {
    const i = (e.target as Element).getAttribute?.('data-bench')
    return i === null || i === undefined ? null : (bench.cells[Number(i)] ?? null)
  }
  const benchPeek = (c: BenchCell) => (c.plot ? peekPatch(ctx, c.plot, null, [], c.plot.level) : peekKind(ctx, null, c.open!.blueprint, c.open!.members))
  const inPart = (c: PlanetCell) => part !== null && c.parts.includes(part)
  return (
    <>
      <div ref={ref} className="relative mx-auto w-full max-w-[min(100%,calc(100dvh-9rem))] desk:absolute desk:inset-0 desk:max-w-none" style={desk ? undefined : { aspectRatio: `${view.w} / ${view.h}` }}>
        <svg
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className="block size-full"
          role="group"
          aria-label={`${m.holder.title} as a ${lower(w.planet)}: each ${lower(w.place)} is a place, each cell a ${lower(w.plot)} that runs there or a ${w.patch} of open ground, painted by its broken checks.`}
          onClick={(e) => !(e.target as Element).closest('[data-cell],[data-bench],a') && ctx.peek(null)}
        >
          <defs>
            <radialGradient id={`${uid}-sea`} cx="42%" cy="40%" r="62%">
              <stop offset="0" stopColor="var(--color-atlas-sea)" />
              <stop offset="1" stopColor="var(--color-atlas-sea-deep)" />
            </radialGradient>
            <radialGradient id={`${uid}-atmo`}>
              <stop offset="0.86" stopColor="var(--color-orbit)" stopOpacity="0" />
              <stop offset="0.93" stopColor="var(--color-orbit)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--color-orbit)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${uid}-night`} cx="30%" cy="28%" r="90%">
              <stop offset="0.45" stopColor="#000" stopOpacity="0" />
              <stop offset="0.85" stopColor="#000" stopOpacity="0.4" />
              <stop offset="1" stopColor="#000" stopOpacity="0.62" />
            </radialGradient>
            <clipPath id={`${uid}-globe`}>
              <circle cx={C} cy={C} r={R} />
            </clipPath>
            <pattern id={`${uid}-fogcell`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <rect width="5" height="5" fill="var(--color-atlas-bare)" />
              <rect width="5" height="2" fill="var(--color-atlas-fog)" />
            </pattern>
            <pattern id={`${uid}-bare`} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill="var(--color-atlas-bare)" />
              <circle cx="3" cy="3" r="0.8" fill="var(--color-atlas-bare-line)" />
            </pattern>
            <WeatherDefs id={uid} />
          </defs>
          <g aria-hidden>
            {STARS.map(([x, y, r, o], i) => (
              <circle key={i} cx={x} cy={y} r={r} fill="var(--color-ink-200)" opacity={o} />
            ))}
            <circle cx={C} cy={C} r={R + 34} fill={`url(#${uid}-atmo)`} />
            <circle cx={C} cy={C} r={R} fill={`url(#${uid}-sea)`} />
          </g>
          <g
            clipPath={`url(#${uid}-globe)`}
            className="cursor-pointer outline-none"
            role="application"
            tabIndex={planet.cells.length ? 0 : undefined}
            aria-label={`The cells of ${m.holder.title}, ${n(planet.cells.length)} of them. The arrow keys move from cell to cell; Enter opens the one you stand on.`}
            onFocus={() => setStood((was) => was ?? 0)}
            onBlur={() => setStood(null)}
            onKeyDown={onKey}
            onPointerMove={(e) => {
              const i = cellAt(e)
              if (i === null) {
                setHover(null)
                ctx.hideTip()
                return
              }
              if (i !== hover) setHover(i)
              ctx.showTip(e, tipOf(planet.cells[i]!))
            }}
            onPointerLeave={() => {
              setHover(null)
              ctx.hideTip()
            }}
            onClick={(e) => {
              const i = cellAt(e)
              const next = i === null ? null : peekOf(planet.cells[i]!)
              ctx.peek(next && next.id === ctx.peeked?.id ? null : next)
            }}
            onDoubleClick={(e) => {
              const i = cellAt(e)
              if (i !== null) navigate(deeper(planet.cells[i]!))
            }}
          >
            <Land planet={planet} uid={uid} front={front} />
            <circle cx={C} cy={C} r={R} fill={`url(#${uid}-night)`} pointerEvents="none" />
            <g pointerEvents="none">
              {/* A part picked: the cells that hold none of it stand back, one line runs round its region on each land, and a cell of another region that holds some of it wears a dashed edge. */}
              {part !== null && planet.cells.map((c, i) => (inPart(c) ? null : <polygon key={`p${i}`} points={pointsOf(c.poly)} fill="var(--color-ink-950)" fillOpacity={0.62} />))}
              {part !== null && <path data-part d={planetEdges(planet, (c, o) => o.land === c.land, (c) => c.part === part)} fill="color-mix(in oklab, var(--color-ink-50) 8%, transparent)" stroke="var(--color-ink-50)" strokeWidth={2.6} strokeLinecap="round" />}
              {part !== null && planet.cells.map((c, i) => (inPart(c) && c.part !== part ? <polygon key={`q${i}`} points={pointsOf(c.poly)} fill="none" stroke="var(--color-ink-50)" strokeWidth={1.6} strokeDasharray="4 3" /> : null))}
              {/* A place pointed at in the panel: its land is outlined. */}
              {lit?.startsWith('place:') && planet.cells.map((c, i) => (`place:${placeOf(c).key}` === lit ? <polygon key={`s${i}`} points={pointsOf(c.poly)} fill="none" stroke="var(--color-ink-50)" strokeWidth={1.6} /> : null))}
              {/* A fix pointed at: every cell holding a thing it holds back lights. */}
              {lit?.startsWith('fix:') && planet.cells.map((c, i) => ([...c.here, ...(c.patch ? [c.patch.plot] : [])].some((x) => x.checks.some((k) => k.state === 'fail' && `fix:${k.title}\0${k.fix}` === lit)) ? <polygon key={`f${i}`} points={pointsOf(c.poly)} fill="color-mix(in oklab, var(--color-orbit) 35%, transparent)" stroke="var(--color-ink-50)" strokeWidth={2.4} /> : null))}
              {/* A row of Tend first pointed at: its cells light, on every continent it runs on. */}
              {lit && planet.cells.map((c, i) => ((c.patch && lit === c.patch.plot.key) || (c.open && lit === `open:${placeOf(c).key}:${c.open.blueprint}`) ? <polygon key={`g${i}`} points={pointsOf(c.poly)} fill="color-mix(in oklab, var(--color-orbit) 35%, transparent)" stroke="var(--color-ink-50)" strokeWidth={2.4} /> : null))}
              {/* The opened garden, on every continent it runs on, in the colour of a choice; the cell opened wears a second line. */}
              {pickedCopies.map((o, i) => (
                <g key={`k${i}`}>
                  <polygon points={pointsOf(o.poly)} fill="none" stroke="var(--color-ink-950)" strokeWidth={4.6} strokeLinejoin="round" />
                  <polygon points={pointsOf(o.poly)} fill="none" stroke="var(--color-orbit)" strokeWidth={2.4} strokeLinejoin="round" />
                </g>
              ))}
              {picked && (
                <g data-picked>
                  <polygon points={pointsOf(picked.poly)} fill="color-mix(in oklab, var(--color-orbit) 45%, transparent)" stroke="var(--color-ink-50)" strokeWidth={6} strokeLinejoin="round" />
                  <polygon points={pointsOf(picked.poly)} fill="none" stroke="var(--color-orbit)" strokeWidth={3} strokeLinejoin="round" />
                </g>
              )}
              {picked && arcs(at(picked), pickedCopies.map(at), 'var(--color-ink-50)', true)}
              {!picked && pickedCopies[0] && arcs(at(pickedCopies[0]), pickedCopies.map(at), 'var(--color-ink-50)', true)}
              {benchCopies.map((o, i) => (
                <polygon key={`b${i}`} points={pointsOf(o.poly)} fill="none" stroke="var(--color-ink-50)" strokeWidth={2.2} />
              ))}
              {benchCopies[0] && arcs(at(benchCopies[0]), benchCopies.map(at), 'var(--color-ink-50)')}
              {copies.map((o, i) => (
                <polygon key={i} points={pointsOf(o.poly)} fill="none" stroke="var(--color-ink-50)" strokeWidth={2.2} />
              ))}
              {standing && <polygon points={pointsOf(standing.poly)} fill="color-mix(in oklab, var(--color-orbit) 35%, transparent)" stroke="var(--color-orbit)" strokeWidth={3} />}
              {hovered && arcs(at(hovered), copies.map(at), 'var(--color-ink-50)')}
            </g>
          </g>
          <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-atlas-rim)" strokeOpacity={0.35} strokeWidth={1.2} pointerEvents="none" />
          {labels.map((lb, i) => {
            const to = ctx.route({ at: lb.l.place.key })
            const tip = (e: React.PointerEvent) =>
              ctx.showTip(
                e,
                <>
                  <TipTitle>{lb.l.place.title}</TipTitle>
                  {w.place}: {saysOf(lb.y)}.
                  <span className="block text-ink-300">
                    {counted(lb.l.place.plots, lower(w.plot))} · {counted(lb.l.open.length, w.patch, w.patches)}
                  </span>
                </>,
              )
            // Its name: over its count on the land itself, or, for a land too small, outside it on a line back to its nearest cell.
            const out = lb.fits ? null : outside.get(i)
            const name: Box = out ?? { x: lb.at[0] - lb.wide / 2, y: lb.at[1] - lb.r - px(4, scale) - lb.tall, w: lb.wide, h: lb.tall }
            const mid: Point = [name.x + name.w / 2, name.y + name.h / 2]
            const foot: Point | null = out ? lb.l.cells.reduce<Point>((a, c) => (Math.hypot(c.x - mid[0], c.y - mid[1]) < Math.hypot(a[0] - mid[0], a[1] - mid[1]) ? [c.x, c.y] : a), [lb.l.middle[0], lb.l.middle[1]]) : null
            const end: Point = out && foot ? nearestOn(out, foot) : [0, 0]
            return (
              <SvgLink key={lb.l.place.key} to={to} label={`${lb.l.place.title}, a ${lower(w.place)}: ${saysOf(lb.y)}.`} onPointerMove={tip} onPointerLeave={ctx.hideTip}>
                <rect x={Math.min(name.x, lb.at[0] - px(23, scale))} y={name.y} width={Math.max(name.w, px(46, scale))} height={Math.max(name.h + (out ? 0 : 2 * lb.r + px(4, scale)), px(46, scale))} fill="transparent" />
                {foot && <line x1={foot[0]} y1={foot[1]} x2={end[0]} y2={end[1]} stroke="var(--color-ink-200)" strokeOpacity={0.7} strokeWidth={px(1.2, scale)} />}
                <rect x={name.x} y={name.y} width={name.w} height={name.h} rx={px(6, scale)} fill="var(--color-ink-950)" fillOpacity={out ? 0.75 : 0.55} />
                <text data-place={lb.l.place.key} x={name.x + name.w / 2} y={name.y + lb.big * 0.92} textAnchor="middle" fontSize={lb.big} fill="currentColor" className="atlas-halo font-serif text-ink-50" strokeWidth={px(5, scale)}>
                  {lb.l.place.title}
                </text>
                {lb.eye && <StormEye x={lb.eye[0]} y={lb.eye[1]} n={lb.y.fail} r={lb.r} size={eyeText} />}
              </SvgLink>
            )
          })}
          {bench.cells.length > 0 && (
            <g>
              <rect x={benchAt[0] - 3} y={benchAt[1] - 3} width={benchW + 6} height={bench.h + 6} rx={4} fill="var(--color-atlas-recede)" stroke={lit === 'bench' ? 'var(--color-ink-50)' : 'var(--color-atlas-stake)'} strokeWidth={lit === 'bench' ? 2.5 : 1.2} aria-hidden />
              <g
                className="cursor-pointer"
                onPointerMove={(e) => {
                  const c = benchCell(e)
                  const i = c ? bench.cells.indexOf(c) : null
                  if (i !== benchHover) setBenchHover(i)
                  if (!c) return ctx.hideTip()
                  ctx.showTip(
                    e,
                    <>
                      <TipTitle>{c.plot ? c.plot.title : ctx.kindName(c.open!.blueprint)}</TipTitle>
                      {c.plot ? (
                        <>
                          Its own checks: {saysOf(tally([c.plot], front))}.
                          <span className="block text-ink-300">{c.plot.at.length ? `Grows on ${listOf(c.plot.at.map((a) => m.places.find((pl) => pl.key === a.place)?.title ?? a.place))}.` : `On no ${lower(w.place)} yet.`}</span>
                        </>
                      ) : (
                        `${counted(c.open!.members.length, 'thing')} on no ${lower(w.place)}: ${saysOf(tally(c.open!.members, front))}.`
                      )}
                    </>,
                  )
                }}
                onPointerLeave={() => {
                  setBenchHover(null)
                  ctx.hideTip()
                }}
                onClick={(e) => {
                  const c = benchCell(e)
                  if (!c) return
                  const next = benchPeek(c)
                  ctx.peek(next.id === ctx.peeked?.id ? null : next)
                }}
              >
                {bench.cells.map((c, i) => (
                  <rect key={i} data-bench={i} className="atlas-cell" x={benchAt[0] + c.x + 0.5} y={benchAt[1] + c.y + 0.5} width={c.s - 1} height={c.s - 1} rx={1.5} fill={cellFill(tally(c.plot ? [c.plot] : c.open!.members, front), uid)} stroke={c.plot ? 'var(--color-atlas-hedge)' : 'var(--color-atlas-coast)'} strokeWidth={1} strokeDasharray={c.plot ? undefined : '2 2'} />
                ))}
                {/* The bench cell the open peek is of. */}
                {bench.cells.map((c, i) =>
                  opened && (c.plot ? patchId(null, c.plot.key) : kindId(null, c.open!.blueprint)) === opened.id ? <rect key={`k${i}`} data-picked pointerEvents="none" x={benchAt[0] + c.x - 1} y={benchAt[1] + c.y - 1} width={c.s + 2} height={c.s + 2} rx={2.5} fill="color-mix(in oklab, var(--color-orbit) 30%, transparent)" stroke="var(--color-orbit)" strokeWidth={2.2} /> : null,
                )}
                {/* The garden's own cell, when the cell opened is one of its copies on the globe. */}
                {picked && pickedBench && <rect pointerEvents="none" x={benchAt[0] + pickedBench.x - 1} y={benchAt[1] + pickedBench.y - 1} width={pickedBench.s + 2} height={pickedBench.s + 2} rx={2.5} fill="none" stroke="var(--color-orbit)" strokeWidth={2.2} />}
              </g>
              <SvgLink
                to={ctx.route({ at: null })}
                label={`${w.unplaced}: ${saysOf(benchT)}.`}
                onPointerMove={(e) =>
                  ctx.showTip(
                    e,
                    <>
                      <TipTitle>{w.unplaced}</TipTitle>
                      Each {lower(w.plot)}&rsquo;s own checks, and what is on no {lower(w.place)}: {saysOf(benchT)}.
                      <span className="block text-ink-300">
                        {counted(nowhere.plots.length, lower(w.plot))} · {counted(nowhere.members.length, 'thing')} on no {lower(w.place)}
                      </span>
                    </>,
                  )
                }
                onPointerLeave={ctx.hideTip}
              >
                <rect x={benchAt[0]} y={benchAt[1] + bench.h + px(4, scale)} width={Math.max(benchText, px(46, scale))} height={px(46, scale)} fill="transparent" />
                <text x={benchAt[0]} y={benchAt[1] + bench.h + px(22, scale)} fontSize={px(17, scale)} fill="currentColor" className="atlas-halo font-serif text-ink-100" strokeWidth={px(4, scale)}>
                  {w.unplaced}
                </text>
                <text x={benchAt[0]} y={benchAt[1] + bench.h + px(40, scale)} fontSize={px(13, scale)} fill="currentColor" className={`atlas-halo ${benchT.fail ? 'text-red' : 'text-ink-200'}`} strokeWidth={px(4, scale)}>
                  {benchWords}
                </text>
              </SvgLink>
            </g>
          )}
        </svg>
      </div>
      {/* The cell a keyboard reader stands on, said aloud as they move. */}
      <p aria-live="polite" className="sr-only">
        {standing ? spoken(standing) : ''}
      </p>
    </>
  )
}

// A continent ----------------------------------------------------------------------

/**
 * A bed of a continent's meadow: a garden there, or the things of one kind on
 * open ground. `things` are what sits on the continent and is counted there;
 * a garden's own checks are its own, on no continent. `ticks` is what
 * ticking it ticks: a garden's own entity with its things. `scope` names it as
 * a walk keeps a stop to it.
 */
interface Bed {
  id: string
  title: string
  level: StatusLevel
  open: boolean
  things: MapThing[]
  ticks: MapThing[]
  to: Route
  t: CheckTally
  scope: string
  /** What a click on it opens. */
  peek: Peeked
}

/** The one order of the worst, the same on every screen: most broken, then most checks, then by name. */
const worstFirst = (a: Bed, b: Bed) => b.t.fail - a.t.fail || b.t.pass + b.t.fail + b.t.unknown - (a.t.pass + a.t.fail + a.t.unknown) || a.title.localeCompare(b.title)

/** The gardens on a place and its open ground kind by kind, each worst first. A garden counts the things it runs there; its own checks are kept apart. */
function bedsOf(ctx: Ctx, at: string | null): Bed[] {
  const { m, front } = ctx
  const gardens: Bed[] =
    at === null
      ? // What names no place has no continent: a garden there is its own entity alone, and its own checks are all it has.
        nowhereOf(m).plots.map((plot) => ({ id: plot.key, title: plot.title, level: plot.level, open: false, things: [plot], ticks: [plot], to: ctx.route({ at, plot: plot.key }), t: tally([plot], front), scope: `plot:${plot.key}`, peek: peekPatch(ctx, plot, null, [], plot.level) }))
      : patchesOn(m, at).map((p) => ({ id: p.plot.key, title: p.plot.title, level: p.level, open: false, things: p.members, ticks: [p.plot, ...p.members], to: ctx.route({ at, plot: p.plot.key }), t: tally(p.members, front), scope: `plot:${p.plot.key}`, peek: peekPatch(ctx, p.plot, at, p.members, p.level) }))
  const open = at === null ? nowhereOf(m).members : m.members.filter((x) => x.place === at && !x.plot)
  const opens: Bed[] = [...new Set(open.map((x) => x.blueprint))].map((bp) => {
    const things = open.filter((x) => x.blueprint === bp)
    return { id: `open:${bp}`, title: ctx.kindName(bp), level: things.map((x) => x.level).reduce<StatusLevel>(worse, 'grey'), open: true, things, ticks: things, to: ctx.route({ at, kind: bp }), t: tally(things, front), scope: `kind:${bp}`, peek: peekKind(ctx, at, bp, things) }
  })
  return [...gardens, ...opens].sort(worstFirst)
}

/** How many of the worst carry a number on the meadow, the same as in the panel's list. */
const CALLOUTS = 10

/** The worst on a continent, gardens and open ground together, by broken checks: the numbers the meadow and the panel carry, the worst first. */
const rankOf = (beds: readonly Bed[]) =>
  new Map(
    beds
      .filter((g) => g.t.fail > 0)
      .slice(0, CALLOUTS)
      .map((g, i) => [g.id, i + 1]),
  )

/** The ladders the lens leaves: all of them, or the one it asks about. */
const lensed = (ctx: Ctx) => (ctx.front ? ctx.m.ladders.filter((l) => l.id === ctx.front) : ctx.m.ladders)

/** A flower's size: it grows with the things it holds, so the biggest bed is the biggest flower. */
const flowerR = (things: number, scale = 1) => Math.round(Math.min(118, (24 + 11 * Math.sqrt(things)) * scale))

/** A number in a filled circle: the rank a bed or a thing carries on the picture and in the panel. */
const Rank = ({ n: k, on = false }: { n: number; on?: boolean }) => (
  <span role="img" aria-label={`Number ${k}`} className={`inline-grid size-5 shrink-0 place-items-center rounded-full text-[12px] font-bold text-ink-950 ${on ? 'bg-orbit' : 'bg-ink-50'}`}>
    {k}
  </span>
)

/**
 * A continent's meadow: one flower a bed, the worst first, each as big as
 * what it holds. A flower's petals are its ladders, each at the same bearing
 * on every flower; a petal is as wide as its share of things and as long as
 * the rung they reached. What the walk grows is drawn in gold. The beds with
 * nothing broken stand smaller after them, a garden of one thing that holds
 * is a small flower by its name, and what nothing checks is named last. A
 * click opens a peek; with `opens`, it goes straight to its layer. What the
 * walk grows only repaints: a gold border round a bed, never a line that
 * moves the beds under it.
 */
function Meadow({ ctx, beds, lifts, opens = false, className = '' }: { ctx: Ctx; beds: readonly Bed[]; lifts: Lifts<MapThing>; opens?: boolean; className?: string }) {
  const ladders = ctx.m.ladders
  const ranks = rankOf(beds)
  const checked = (b: Bed) => b.things.some((x) => x.checks.length > 0)
  const tending = beds.filter((b) => b.t.fail > 0)
  const holding = beds.filter((b) => !b.t.fail && checked(b) && (b.open || b.things.length > 1))
  const potted = beds.filter((b) => !b.t.fail && checked(b) && !b.open && b.things.length <= 1)
  const unsown = beds.filter((b) => !checked(b))
  const press = (b: Bed) => (opens ? navigate(b.to) : ctx.peek(ctx.peeked?.id === b.peek.id ? null : b.peek))
  const tip = (e: React.PointerEvent, b: Bed) =>
    ctx.showTip(
      e,
      <>
        <TipTitle>{b.title}</TipTitle>
        {counted(b.things.length, 'thing')}: {saysOf(b.t)}.
      </>,
    )
  const flower = (b: Bed, scale: number) => {
    const grows = b.things.some((x) => x.checks.some((c) => c.state === 'fail' && lifts(x, c.ladder)))
    const shape = flowerOf(b.things, ladders, flowerR(b.things.filter((x) => x.checks.length).length, scale), lifts)
    return (
      <li key={b.id}>
        <button type="button" aria-pressed={ctx.peeked?.id === b.peek.id} aria-label={`${b.title}: ${saysOf(b.t)}${grows ? `, grows on ${lower(ctx.w.walk)}` : ''}`} onClick={() => press(b)} onPointerMove={(e) => tip(e, b)} onPointerLeave={ctx.hideTip} className={`flex max-w-[260px] flex-col items-center rounded-xl border px-2 pt-1 pb-2 text-center ${ctx.peeked?.id === b.peek.id ? 'border-orbit bg-ink-900/60' : grows ? 'border-dashed border-[var(--color-atlas-route)] bg-[color-mix(in_oklab,var(--color-atlas-route)_6%,transparent)]' : 'border-transparent hover:border-ink-600'}`}>
          <FlowerArt shape={shape} lens={ctx.front} />
          <span className="mt-1 flex items-start justify-center gap-1.5 text-[14px] leading-snug font-medium text-ink-50">
            {ranks.has(b.id) && <Rank n={ranks.get(b.id)!} />}
            <NameText name={b.title} />
          </span>
          <span className={`text-[12px] ${b.t.fail ? 'text-red' : 'text-ink-300'}`}>{b.t.fail ? `${n(b.t.fail)} broken` : b.t.unknown ? `${n(b.t.unknown)} no data` : 'in full bloom'}</span>
          <span className="text-[12px] text-ink-300">{counted(b.things.length, 'thing')}</span>
        </button>
      </li>
    )
  }
  const wrap = 'flex flex-wrap items-end gap-x-3 gap-y-1'
  return (
    <section aria-label={`The ${lower(ctx.w.place)}, bed by bed`} className={`rounded-2xl border border-ink-800 p-3 ${className}`} style={{ background: 'radial-gradient(ellipse at 30% 0%, color-mix(in oklab, var(--color-atlas-field) 22%, transparent), transparent 60%), var(--color-atlas-earth)' }}>
      {tending.length > 0 && <ul className={wrap}>{tending.map((b) => flower(b, 1))}</ul>}
      {holding.length > 0 && <ul className={`${wrap} ${tending.length ? 'mt-2 border-t border-[var(--color-atlas-furrow)] pt-2' : ''}`}>{holding.map((b) => flower(b, 0.62))}</ul>}
      {potted.length > 0 && (
        <ul aria-label="Each one thing, in full bloom" className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-[var(--color-atlas-furrow)] pt-2">
          {potted.map((b) => (
            <li key={b.id}>
              <button type="button" aria-pressed={ctx.peeked?.id === b.peek.id} onClick={() => press(b)} onPointerMove={(e) => tip(e, b)} onPointerLeave={ctx.hideTip} className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-1.5 text-left text-[13px] text-ink-200 md:min-h-8 ${ctx.peeked?.id === b.peek.id ? 'border-orbit' : 'border-transparent hover:border-ink-600'}`}>
                <FlowerArt shape={flowerOf(b.things, ladders, 11, lifts)} lens={ctx.front} />
                <NameText name={b.title} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {unsown.length > 0 && (
        <p className="mt-2 border-t border-[var(--color-atlas-furrow)] pt-2 text-[13px] text-ink-300">
          Nothing checks {unsown.map((b) => `${b.title} (${n(b.things.length)})`).join(', ')}.
        </p>
      )}
    </section>
  )
}

/**
 * The walk: every climb among some things, the one that mends the most first,
 * each a stop on a path. A stop says how far its things stand, what it
 * mends, and what comes into full bloom when it is done; its things stand
 * under it as small flowers, by the bed they grow in, each opening a peek.
 * Where the hub keeps the reader's walk, a stop is added or taken off with
 * one press. Pointing at a stop shows on the meadow what it grows, and a
 * press on its name holds that there while the walk scrolls.
 */
function WalkStops({ ctx, at, scope, things, beds, walk, onLight, held, onHold }: { ctx: Ctx; at: string | null; scope: string | null; things: readonly MapThing[]; beds: readonly Bed[]; walk: Walking; onLight: (climb: MapClimb<MapThing> | null) => void; held: string | null; onHold: (key: string | null) => void }) {
  const ladders = ctx.m.ladders
  const climbs = climbsOf(things, lensed(ctx))
  const bedOf = new Map(beds.flatMap((b) => b.things.map((x) => [tickId(x), b.title] as const)))
  const now = walk.lifts
  if (!climbs.length) return <p className="mt-4 text-[13px] text-ink-300">{tally(things, ctx.front).fail ? 'Every broken check here waits on data a rung below it, so there is nothing to climb yet.' : 'Nothing here is broken, so there is nothing to climb.'}</p>
  return (
    <section aria-label={ctx.w.climbs} className="mt-6">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-serif text-[28px] leading-none text-ink-50">{ctx.w.climbs}</h2>
        <p className="text-[13px] text-ink-300">
          {counted(climbs.length, ctx.w.stop)}, the most mended first. Point at one to see what it grows, or press its name to hold it.
        </p>
      </div>
      <ol className="relative space-y-2.5 pl-11 before:absolute before:top-5 before:bottom-5 before:left-[17px] before:w-1 before:rounded-full before:bg-[repeating-linear-gradient(180deg,var(--color-atlas-stake)_0_6px,transparent_6px_11px)]" onPointerLeave={() => onLight(null)}>
        {climbs.map((c, i) => {
          const ladder = ladders.find((l) => l.id === c.ladder)
          const step = walk.steps ? stopOn(walk.steps, c, at, scope) : null
          const covered = !step && c.things.every((x) => now(x, c.ladder))
          const blooms = bloomsWith(beds, ladders, now, (x, l) => now(x, l) || (l === c.ladder && c.things.includes(x)))
          const groups = new Map<string, MapThing[]>()
          for (const x of c.things) groups.set(bedOf.get(tickId(x)) ?? ctx.kindName(x.blueprint), [...(groups.get(bedOf.get(tickId(x)) ?? ctx.kindName(x.blueprint)) ?? []), x])
          const key = climbKey(c)
          return (
            <li key={key} onPointerEnter={() => onLight(c)} onFocus={() => onLight(c)} className={`relative rounded-xl border p-3 ${held === key ? 'ring-2 ring-orbit ' : ''}${step ? 'border-[color-mix(in_oklab,var(--color-atlas-route)_70%,transparent)] bg-[color-mix(in_oklab,var(--color-atlas-route)_5%,var(--color-atlas-earth))]' : 'border-ink-800 bg-[var(--color-atlas-earth)]'}`}>
              <span aria-hidden className={`absolute top-3 -left-11 grid size-9 place-items-center rounded-full border-2 text-[14px] font-bold ${step ? 'border-[var(--color-atlas-route)] bg-[var(--color-atlas-route)] text-ink-950' : 'border-[var(--color-atlas-stake)] bg-ink-900 text-ink-50'}`}>
                {i + 1}
              </span>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <h3 className="text-[16px] leading-snug font-medium text-ink-50">
                    <button type="button" aria-pressed={held === key} onClick={() => onHold(held === key ? null : key)} className="-mx-1 rounded-md px-1 text-left underline-offset-4 hover:underline">
                      {climbText(c, ladder)}
                    </button>
                  </h3>
                  <p className="text-[13px] text-ink-200">
                    {blooms.length ? (
                      <>
                        Done, and{' '}
                        {blooms.map((b, k) => (
                          <span key={b.id} className="font-medium text-[var(--color-atlas-route-ink)]">
                            <NameText name={b.title} after={k < blooms.length - 1 ? ',' : ''} />{' '}
                          </span>
                        ))}
                        {blooms.length === 1 ? 'comes' : 'come'} into full bloom.
                      </>
                    ) : (
                      `${counted(c.things.length, 'thing')} ${c.things.length === 1 ? 'climbs' : 'climb'} to the top.`
                    )}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <p className="font-serif text-[30px] leading-none text-ink-50">
                    {n(c.mends)}
                    <span className="ml-1 font-sans text-[12px] text-ink-300">mended</span>
                  </p>
                  {walk.steps && walk.change && (covered ? <span className="text-[13px] text-[var(--color-atlas-route-ink)]">On {lower(ctx.w.walk)}, from another stop</span> : (
                    <button type="button" aria-pressed={!!step} onClick={() => (step ? walk.change!({ remove: step.id }) : walk.change!({ add: stepOf(c, at, scope) }))} className={`btn min-h-11 md:min-h-9 ${step ? 'border-[var(--color-atlas-route)] text-[var(--color-atlas-route-ink)]' : 'btn-ghost'}`}>
                      {step ? `On ${lower(ctx.w.walk)}` : `Add to ${lower(ctx.w.walk)}`}
                    </button>
                  ))}
                </div>
                <ul aria-label={`What ${climbText(c, ladder)} takes`} className="col-span-2 flex flex-wrap gap-x-4 gap-y-1">
                  {[...groups].map(([title, list]) => (
                    <li key={title} className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap gap-0.5">
                        {list.map((x) => (
                          <button key={tickId(x)} type="button" aria-label={`${x.title}: open it`} onClick={() => ctx.peek(ctx.peeked?.id === tickId(x) ? null : peekThing(ctx, x))} onPointerMove={(e) => ctx.showTip(e, <TipTitle>{x.title}</TipTitle>)} onPointerLeave={ctx.hideTip} className="rounded-md p-2 hover:bg-ink-850 md:p-0">
                            <FlowerArt shape={flowerOf([x], ladders, 15, now)} lens={ctx.front} />
                          </button>
                        ))}
                      </span>
                      <span className="text-[12px] text-ink-300">
                        {title} {n(list.length)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** A climb's own name on a page: its ladder and the rung it starts from. */
const climbKey = (c: Pick<MapClimb<MapThing>, 'ladder' | 'from'>) => `${c.ladder}:${c.from}`

/** The reader's walk on this page: their stops (null where the hub keeps none for them), what the stops grow, and the one way to change them, absent while viewing as someone. */
interface Walking {
  steps: WalkStep[] | null
  lifts: Lifts<MapThing>
  change: ((c: { add: WalkStepRequest } | { remove: string }) => void) | null
}

function useWalking(ctx: Ctx, at: string | null): Walking {
  const ref = { blueprint: ctx.m.blueprint, key: ctx.m.holder.key }
  const steps = useWalk(ref).data ?? null
  const change = useWalkChange(ref)
  const viewing = useViewingAs()
  const lifts = useMemo(() => liftsOf<MapThing>(steps ?? [], at), [steps, at])
  return { steps, lifts, change: viewing ? null : change.mutate }
}

/**
 * How far some things have grown, in stages, and how far the walk takes them:
 * one segment a stage, green to where they stand, gold to where the walk
 * goes. While a stop is tried (`trying`, its name), the gold is the walk with
 * that stop, and it says what that leaves broken.
 */
function Growth({ ctx, things, lifts, trying = null }: { ctx: Ctx; things: readonly MapThing[]; lifts: Lifts<MapThing>; trying?: string | null }) {
  const now = growthOf(things, ctx.m.ladders)
  const then = growthOf(things, ctx.m.ladders, lifts)
  if (!now.checked) return null
  const words = ctx.w.growth
  const once = trying ? `with ${trying}` : `once ${lower(ctx.w.walk)} is done`
  const broken = tally(things, ctx.front).fail
  const left = broken - mendedBy(things, (x, l) => (!ctx.front || l === ctx.front) && lifts(x, l))
  return (
    <section>
      <PanelHead title="Growth">
        {n(now.full)} of {counted(now.checked, 'thing')} in full bloom
      </PanelHead>
      <div role="img" aria-label={`${words[now.stage]}${then.stage > now.stage ? `, ${words[then.stage]} ${once}` : ''}`} className="grid grid-cols-5 gap-1">
        {words.map((_, i) => (
          <i key={i} className="block h-2 rounded-full" style={{ background: i <= now.stage ? 'var(--color-signal-green)' : i <= then.stage ? 'repeating-linear-gradient(135deg, var(--color-atlas-route) 0 4px, color-mix(in oklab, var(--color-atlas-route) 40%, transparent) 4px 8px)' : 'var(--color-ink-800)' }} />
        ))}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-300">
        <span className="font-medium text-ink-50">{words[now.stage]}</span>
        {now.stage < GROWTH.length && (
          <>
            {' '}
            · {n(Math.ceil(GROWTH[now.stage]! * now.checked) - now.full)} more in full bloom to reach {words[now.stage + 1]}
          </>
        )}
        {then.stage > now.stage && (
          <span className="text-[var(--color-atlas-route-ink)]">
            {' '}
            · {words[then.stage]} {once}
          </span>
        )}
      </p>
      {trying && (
        <p aria-live="polite" className="mt-1.5 text-[13px] text-[var(--color-atlas-route-ink)]">
          <span className="font-medium">
            {n(broken)} → {n(left)}
          </span>{' '}
          broken {once}
        </p>
      )}
    </section>
  )
}

/**
 * The reader's walk in the panel: what it leaves broken when it is done, then
 * each stop on this place with how far it has come, walked once every thing
 * it named stands at the top, and the one press that takes it off.
 */
function YourWalk({ ctx, at, things, walk, scopeTitle }: { ctx: Ctx; at: string | null; things: readonly MapThing[]; walk: Walking; scopeTitle: (scope: string) => string }) {
  if (!walk.steps) return null
  const here = walk.steps.filter((s) => s.place === at)
  const byId = new Map([...ctx.m.plots, ...ctx.m.members].map((x) => [tickId(x), x]))
  const broken = tally(things, ctx.front).fail
  const left = broken - mendedBy(things, (x, l) => (!ctx.front || l === ctx.front) && walk.lifts(x, l))
  return (
    <section>
      <PanelHead title={ctx.w.walk} />
      {!here.length ? (
        <p className="text-[13px] text-ink-300">Add a stop from {lower(ctx.w.climbs)} and it waits for you here, on every device.</p>
      ) : (
        <>
          <div aria-live="polite" className="rounded-xl border border-[color-mix(in_oklab,var(--color-atlas-route)_40%,var(--color-ink-800))] bg-[color-mix(in_oklab,var(--color-atlas-route)_4%,var(--color-ink-950))] px-3.5 py-3">
            <p className="font-serif text-[34px] leading-none text-ink-50">
              <span className="text-red">{n(broken)}</span> → <span className={left ? 'text-red' : 'text-[var(--color-atlas-route-ink)]'}>{n(left)}</span>
            </p>
            <p className="mt-1.5 text-[13px] text-ink-300">broken once {lower(ctx.w.walk)} is done.</p>
          </div>
          <ul className="mt-2 space-y-1">
            {here.map((s) => {
              const ladder = ctx.m.ladders.find((l) => l.id === s.ladder)
              const p = progressOf(s, byId, ladder)
              return (
                <li key={s.id} className="flex items-start gap-2 border-b border-ink-800 py-1.5">
                  <span aria-hidden className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold ${p.walked ? 'bg-[var(--color-signal-green)] text-ink-950' : 'border-2 border-[var(--color-atlas-route)] text-[var(--color-atlas-route-ink)]'}`}>
                    {p.walked ? '✓' : ''}
                  </span>
                  <div className="min-w-0 flex-1 text-[13px] leading-snug">
                    <p className="font-medium text-ink-50">{climbText(s, ladder)}</p>
                    <p className="text-ink-300">
                      {s.scope ? `${scopeTitle(s.scope)} · ` : ''}
                      {p.walked ? 'walked' : `${n(p.done)} of ${counted(p.of, 'thing')} at the top`}
                    </p>
                    <span aria-hidden className="mt-1 block h-1 rounded-full bg-ink-800">
                      <i className="block h-full rounded-full bg-signal-green" style={{ width: `${p.of ? (p.done / p.of) * 100 : 0}%` }} />
                    </span>
                  </div>
                  {walk.change && (
                    <button type="button" onClick={() => walk.change!({ remove: s.id })} className="btn btn-ghost min-h-11 min-w-11 shrink-0 px-2 md:min-h-8 md:min-w-8" aria-label={`Take ${climbText(s, ladder)} off ${lower(ctx.w.walk)}`}>
                      <X aria-hidden className="size-3.5" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

/** The words a scope of a stop goes by: its garden's or its kind's. */
const scopeName = (ctx: Ctx) => (scope: string) => (scope.startsWith('plot:') ? (ctx.m.plots.find((p) => p.key === scope.slice(5))?.title ?? scope.slice(5)) : ctx.kindName(scope.slice(5)))

/** The key of a flower, in its own marks. */
function flowerKey(w: MapWords, ladders: readonly MapLadder[]): KeyMark[] {
  const mark = (states: ('pass' | 'fail' | 'unknown')[][], lifts: Lifts<Pick<MapThing, 'checks'>> = () => false) => <FlowerArt shape={flowerOf([{ checks: states.flatMap((st, i) => st.map((state, rung) => ({ kind: 'scorecard' as const, id: `${i}:${rung}`, title: '', of: null, state, ladder: `k${i}`, rung }))) }], states.map((_, i) => ({ id: `k${i}`, title: '', rungs: ['a', 'b', 'c'] })), 9)} />
  const named = ladders.length ? ladders.map((l, i) => `${l.title} ${i === 0 ? 'stands straight up' : i === 1 ? 'next, clockwise' : ''}`.trim()).slice(0, 2).join('; ') : 'each ladder'
  return [
    { mark: mark([['pass', 'pass', 'pass']]), word: 'top', says: `A petal is one ladder: a scorecard's levels, or a budget or a guard. ${named}. A full green petal is at the top.` },
    { mark: mark([['pass', 'fail', 'fail']]), word: w.broken, says: 'A short red petal stopped at a broken check; the dashes show what it lacks.' },
    { mark: mark([['pass', 'unknown', 'pass']]), word: w.nodata, says: 'A grey petal stopped at a check with no data. It is never read as holding.' },
    { mark: <span aria-hidden className="inline-block h-3 w-4 rounded-[3px] border border-dashed border-[var(--color-atlas-route)] bg-[color-mix(in_oklab,var(--color-atlas-route)_14%,transparent)]" />, word: 'walk', says: `Gold dashes are what ${lower(w.walk)} grows to the top, and a gold ring holds each bed it grows in.` },
  ]
}

function ContinentView({ ctx, at }: { ctx: Ctx; at: string | null }) {
  const narrow = useNarrow()
  const { m, w, front } = ctx
  const walk = useWalking(ctx, at)
  // A stop pointed at, or held, shows on the meadow and in the panel what the walk grows with it.
  const [lit, setLit] = useState<MapClimb<MapThing> | null>(null)
  const [held, setHeld] = useState<string | null>(null)
  const place = at === null ? null : m.places.find((p) => p.key === at)
  if (at !== null && !place)
    return (
      <div className="py-12">
        <Empty>Nothing on this map is on {at}.</Empty>
      </div>
    )
  const beds = bedsOf(ctx, at)
  // What is here, each thing once: on a place, what its gardens run there and its open ground; in the workshop, each garden's own checks and the things on no place.
  const everything = beds.flatMap((g) => g.things)
  const t = tally(everything, front)
  const numbers = rankOf(beds)
  const ranked = beds.filter((g) => g.t.fail > 0)
  const climbs = climbsOf(everything, lensed(ctx))
  const title = place?.title ?? w.unplaced
  const verdict = (
    <Verdict kicker={`${at === null ? 'No place' : w.place}${ctx.lensTitle ? ` · ${ctx.lensTitle}` : ''}`}>
      {title}: {t.fail ? <Alarm>{n(t.fail)}</Alarm> : 'nothing'} broken
      {climbs[0] ? <Quiet>. One stop mends {n(climbs[0].mends)} of them.</Quiet> : t.unknown ? <Quiet>, {n(t.unknown)} not judged.</Quiet> : '.'}
    </Verdict>
  )
  const trying = lit ?? climbs.find((c) => climbKey(c) === held) ?? null
  const shown = trying ? liftsOf<MapThing>(walk.steps ?? [], at, trying) : walk.lifts
  // On a phone the first screen is the verdict and the meadow; the rest of the panel follows. On a desk the meadow stays pinned over the walk, so a stop far down still shows what it grows.
  const stage = (
    <>
      {narrow && <div className="mb-4">{verdict}</div>}
      <div className="desk:sticky desk:-top-16 desk:z-[5] desk:-mx-3 desk:-mt-16 desk:bg-[var(--color-atlas-space)] desk:px-3 desk:pt-16 desk:pb-1">
        <Meadow ctx={ctx} beds={beds} lifts={shown} className="desk:max-h-[46vh] desk:overflow-y-auto" />
      </div>
      <WalkStops ctx={ctx} at={at} scope={null} things={everything} beds={beds} walk={walk} onLight={setLit} held={held} onHold={setHeld} />
    </>
  )
  const worstTicks = ranked
    .slice(0, CALLOUTS)
    .flatMap((g) => g.ticks)
    .filter((x) => x.actions.length > 0)
  const lensTicks = front ? brokenUnder(everything, front).filter((x) => x.actions.length > 0) : []
  const walkTicks = everything.filter((x) => x.actions.length > 0 && x.checks.some((c) => c.state === 'fail' && walk.lifts(x, c.ladder)))
  const panel = (
    <>
      {!narrow && verdict}
      <SkyBand t={t} words={bandWords(w)} className="mt-5" />
      {ranked.length > 0 && (
        <section>
          <PanelHead title={w.tend} />
          <Ranked
            label={w.tend}
            first={CALLOUTS}
            rows={ranked.map((g): RankRow => {
              const mine = g.ticks.filter((x) => x.actions.length > 0)
              return {
                id: g.id,
                title: g.title,
                says: `${n(g.t.fail)} broken of ${n(g.t.pass + g.t.fail + g.t.unknown)}`,
                broken: g.t.fail,
                picked: ctx.peeked?.id === g.peek.id,
                onPick: () => ctx.peek(ctx.peeked?.id === g.peek.id ? null : g.peek),
                mark: numbers.has(g.id) ? <Rank n={numbers.get(g.id)!} /> : undefined,
                after:
                  mine.length > 0 ? (
                    <label className="inline-flex size-11 shrink-0 items-center justify-center md:size-8">
                      <input type="checkbox" className="size-4" aria-label={`Tick ${g.title}`} checked={mine.every((x) => ctx.ticked.has(tickId(x)))} onChange={(e) => ctx.tick(mine, e.target.checked)} />
                    </label>
                  ) : undefined,
              }
            })}
          />
        </section>
      )}
      <Growth ctx={ctx} things={everything} lifts={shown} trying={trying ? climbText(trying, m.ladders.find((l) => l.id === trying.ladder)) : null} />
      <YourWalk ctx={ctx} at={at} things={everything} walk={walk} scopeTitle={scopeName(ctx)} />
      {(worstTicks.length > 0 || lensTicks.length > 0 || walkTicks.length > 0) && (
        <section>
          <PanelHead title={WORDS.hands} />
          <div className="flex flex-wrap gap-2">
            {walkTicks.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(walkTicks, true)}>
                Tick the {n(walkTicks.length)} on {lower(w.walk)}
              </button>
            )}
            {worstTicks.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(worstTicks, true)}>
                Tick the first {n(Math.min(CALLOUTS, ranked.length))}
              </button>
            )}
            {lensTicks.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(lensTicks, true)}>
                Tick the {n(lensTicks.length)} it breaks on
              </button>
            )}
          </div>
        </section>
      )}
    </>
  )
  const legend: KeyMark[] = [...flowerKey(w, m.ladders), { mark: <Rank n={1} />, word: 'rank', says: `The number on a flower is its rank: the ${lower(w.plot)} or ${w.patch} with the most broken checks is 1.` }]
  return <Shell crumbs={ctx.crumbs} stage={stage} over={ctx.lens(everything)} panel={panel} peek={ctx.peekCard} tray={ctx.tray} scrolls legend={legend} tour={{ id: 'map', steps: MAP_TOUR }} />
}

// A garden -------------------------------------------------------------------------

/**
 * A thing's rungs on each ladder that reads it, as a row of dots under its
 * flower: a held rung filled, a missing one hollow, one the walk grows in
 * gold, and one with no data grey.
 */
function Rungs({ thing, ladders, lifts, lens }: { thing: MapThing; ladders: readonly MapLadder[]; lifts: Lifts<MapThing>; lens: string | null }) {
  const rows = ladders.flatMap((l) => {
    const s = standingOf(thing, l)
    return s ? [{ l, s }] : []
  })
  if (!rows.length) return null
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_auto] justify-center gap-x-2 gap-y-0.5 text-left text-[12px] text-ink-300">
      {rows.map(({ l, s }) => {
        const grows = s.stop === 'fail' && lifts(thing, l.id)
        return (
          <div key={l.id} className={`contents ${lens && lens !== l.id ? '[&>*]:opacity-40' : ''}`}>
            <dt className="truncate">{l.title}</dt>
            <dd className="flex items-center gap-1" aria-label={`${l.title}: ${s.reached ? l.rungs[s.reached - 1] : `below ${l.rungs[0]}`}${s.stop === 'unknown' ? ', then no data' : ''}${grows ? `, grows to ${l.rungs.at(-1)} on the walk` : ''}`}>
              {l.rungs.map((r, k) => (
                <i
                  key={r}
                  title={r}
                  className="inline-block size-2.5 rounded-full border-[1.5px]"
                  style={
                    k < s.reached
                      ? { background: 'var(--color-signal-green)', borderColor: 'var(--color-signal-green)' }
                      : grows
                        ? { borderColor: 'var(--color-atlas-route)', borderStyle: 'dashed' }
                        : k === s.reached && s.stop === 'unknown'
                          ? { borderColor: 'var(--color-atlas-ghost)', borderStyle: 'dotted' }
                          : { borderColor: 'var(--color-ink-500)', borderStyle: 'dashed' }
                  }
                />
              ))}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/**
 * A garden: one held thing on one continent, or one kind of thing on its open
 * ground, as a plate of specimens. One flower a thing, numbered as the panel
 * numbers it, its petals its ladders; under it its name, what stops it next,
 * and its rungs. The walk here, in the panel, climbs inside the garden alone.
 */
function GardenView({ ctx, at, plot, kind }: { ctx: Ctx; at: string | null; plot: string | null; kind: string | null }) {
  const { m, w, front } = ctx
  const walk = useWalking(ctx, at)
  const p = plot ? m.plots.find((x) => x.key === plot) : undefined
  // A garden on a place is what it runs there. In the workshop it is the garden's own entity, for the checks that are its own, with anything of it on no place.
  const things: MapThing[] = p ? (at === null ? [p, ...m.members.filter((x) => x.plot === p.key && x.place === null)] : m.members.filter((x) => x.plot === p.key && x.place === at)) : m.members.filter((x) => (at === null || !x.plot) && x.blueprint === kind && x.place === at)
  const own = p && at !== null ? tally([p], front) : null
  if ((plot && !p) || !things.length)
    return (
      <div className="py-12">
        <Empty>
          Nothing of this is here.
          {p && at !== null && (
            <>
              {' '}
              <Link to={ctx.route({ at: null, plot: p.key })} className="text-ink-100 underline underline-offset-4">
                Its own checks
              </Link>
            </>
          )}
        </Empty>
      </div>
    )
  const scope = p ? `plot:${p.key}` : `kind:${kind}`
  const title = p ? p.title : ctx.kindName(kind!)
  const placeName = at === null ? w.unplaced : (m.places.find((x) => x.key === at)?.title ?? at)
  const t = tally(things, front)
  const total = t.pass + t.fail + t.unknown
  const ladders = m.ladders
  const climbs = climbsOf(things, lensed(ctx))
  const copies = p ? p.at.map((a) => ({ place: a.place, t: tally(m.members.filter((x) => x.plot === p.key && x.place === a.place), front) })) : []
  const able = things.filter((x) => x.actions.length > 0)
  const brokenThings = able.filter((x) => x.checks.some((c) => c.state === 'fail' && (!front || c.ladder === front)))
  const walkTicks = able.filter((x) => x.checks.some((c) => c.state === 'fail' && walk.lifts(x, c.ladder)))
  const full = things.filter((x) => inBloom(x, ladders)).length
  const nextOf = (x: MapThing) => {
    const short = lensed(ctx).flatMap((l) => {
      const s = standingOf(x, l)
      return s && s.stop === 'fail' ? [{ l, s }] : []
    })
    short.sort((a, b) => a.s.reached / a.s.of - b.s.reached / b.s.of)
    const first = short[0]
    return first ? (first.l.rungs.length > 1 ? `next: ${first.l.title} to ${first.l.rungs[first.s.reached]}` : `next: ${first.l.title}`) : null
  }
  const stage = (
    <div>
      {copies.length > 0 && (at === null || copies.length > 1) && (
        <ul aria-label={`The same ${lower(w.plot)} on each ${lower(w.place)}`} className="mb-4 flex flex-wrap gap-1.5">
          {copies.map((c) => (
            <li key={c.place}>
              <Link to={ctx.route({ at: c.place, plot: p!.key })} current={c.place === at} label={`${m.places.find((x) => x.key === c.place)?.title ?? c.place}: ${ofText(c.t)}`} className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-[13px] sm:min-h-9 ${c.place === at ? 'border-orbit bg-ink-950 text-ink-50' : 'border-ink-700 bg-ink-950 text-ink-200 hover:border-ink-500'}`}>
                <ShapeIcon level={checksLevel(c.t)} size={12} />
                {m.places.find((x) => x.key === c.place)?.title ?? c.place}
                <span className={c.t.fail ? 'text-red' : 'text-ink-300'}>{ofText(c.t)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ol aria-label={`Every thing in ${title}, one flower each`} className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-2.5">
        {things.map((x, i) => {
          const id = tickId(x)
          const y = tally([x], front)
          const next = nextOf(x)
          const grows = x.checks.some((c) => c.state === 'fail' && walk.lifts(x, c.ladder))
          const blooms = y.fail > 0 && inBloom(x, ladders, walk.lifts)
          const picked = ctx.peeked?.id === id
          return (
            <li key={id} className={`relative flex flex-col items-center rounded-2xl border px-3 pt-3 pb-3 text-center ${picked ? 'border-orbit' : ctx.ticked.has(id) ? 'border-orbit/60' : 'border-ink-800'}`} style={{ background: `radial-gradient(circle at 50% 34%, color-mix(in oklab, var(--color-atlas-field) ${y.fail || y.unknown ? 14 : 26}%, transparent), var(--color-atlas-earth) 70%)` }}>
              <span className="absolute top-2.5 left-2.5">
                <Rank n={i + 1} on={ctx.ticked.has(id)} />
              </span>
              {x.actions.length > 0 && (
                <label className="absolute top-0.5 right-0.5 inline-flex size-11 items-center justify-center md:size-8">
                  <input type="checkbox" className="size-4" aria-label={`Tick ${x.title}`} checked={ctx.ticked.has(id)} onChange={(e) => ctx.tick([x], e.target.checked)} />
                </label>
              )}
              <button type="button" aria-pressed={picked} aria-label={`${x.title}: ${x.checks.length ? ofText(y) : 'nothing checks it'}`} onClick={() => ctx.peek(picked ? null : peekThing(ctx, x))} className="flex w-full flex-col items-center rounded-xl hover:bg-ink-900/40">
                <FlowerArt shape={flowerOf([x], ladders, 54, walk.lifts)} lens={front} />
                <span className="mt-1 text-[13.5px] leading-snug font-medium text-ink-50">
                  <NameText name={x.title} />
                </span>
                <span className={`text-[12px] ${y.fail ? 'text-red' : 'text-ink-300'}`}>{!x.checks.length ? 'nothing checks it' : y.fail ? `${n(y.fail)} broken${next ? ` · ${next}` : ''}` : y.unknown ? `${n(y.unknown)} no data` : 'at the top everywhere'}</span>
                {blooms ? <span className="text-[12px] text-[var(--color-atlas-route-ink)]">blooms on {lower(w.walk)}</span> : grows ? <span className="text-[12px] text-[var(--color-atlas-route-ink)]">grows on {lower(w.walk)}</span> : null}
              </button>
              <Rungs thing={x} ladders={ladders} lifts={walk.lifts} lens={front} />
            </li>
          )
        })}
      </ol>
    </div>
  )
  const placeOf = (x: MapThing) => {
    const place = 'place' in x ? (x as MapMember).place : undefined
    return place === undefined ? `the ${lower(w.plot)} itself` : place === null ? lower(w.unplaced) : (m.places.find((pl) => pl.key === place)?.title ?? place)
  }
  const mended = mendedBy(things, (x, l) => (!front || l === front) && walk.lifts(x, l))
  const panel = (
    <>
      <Verdict kicker={`${p ? (at === null ? `${ctx.kindName(p.blueprint)}, its own checks` : w.plot) : at === null ? 'Kind' : w.open} · ${placeName}${ctx.lensTitle ? ` · ${ctx.lensTitle}` : ''}`}>
        <NameText name={title} after=":" />{' '}
        {!total ? (
          <Quiet>nothing checks {things.length === 1 ? 'it' : 'these'} yet.</Quiet>
        ) : t.fail ? (
          <>
            <Alarm>{n(t.fail)}</Alarm> broken.{' '}
            <Quiet>
              {n(full)} of {counted(things.length, 'thing')} in full bloom.
            </Quiet>
          </>
        ) : t.unknown ? (
          <Quiet>nothing broken, {n(t.unknown)} not judged.</Quiet>
        ) : (
          <Quiet>in full bloom.</Quiet>
        )}
      </Verdict>
      {total > 0 && <SkyBand t={t} words={bandWords(w)} className="mt-5" />}
      <section>
        <PanelHead title="Things" />
        <Ranked
          label="Each thing here, by its number on the plate"
          rows={things.map((x, i): RankRow => {
            const id = tickId(x)
            const y = tally([x], front)
            return {
              id,
              title: x.title,
              says: [x.checks.length ? `${n(y.fail)} broken of ${n(y.pass + y.fail + y.unknown)}` : 'nothing checks it', ctx.kindName(x.blueprint), p && at === null ? placeOf(x) : ''].filter(Boolean).join(' · '),
              broken: y.fail,
              picked: ctx.peeked?.id === id,
              onPick: () => ctx.peek(ctx.peeked?.id === id ? null : peekThing(ctx, x)),
              mark: <Rank n={i + 1} on={ctx.ticked.has(id)} />,
            }
          })}
        />
      </section>
      {climbs.length > 0 && (
        <section>
          <PanelHead title={`${ctx.w.climbs} here`} />
          <ol className="space-y-0.5">
            {climbs.map((c, i) => {
              const ladder = ladders.find((l) => l.id === c.ladder)
              const step = walk.steps ? stopOn(walk.steps, c, at, scope) : null
              // A stop made on the whole continent, or on another garden, may already take these things to the top.
              const covered = !step && c.things.every((x) => walk.lifts(x, c.ladder))
              const on = !!step || covered
              return (
                <li key={`${c.ladder}:${c.from}`} className="flex items-center gap-2 border-b border-ink-800 py-1.5">
                  <span aria-hidden className={`grid size-6 shrink-0 place-items-center rounded-full border-2 text-[12px] font-bold ${on ? 'border-[var(--color-atlas-route)] bg-[var(--color-atlas-route)] text-ink-950' : 'border-[var(--color-atlas-stake)] text-ink-50'}`}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 text-[13px] leading-snug">
                    <p className="font-medium text-ink-50">{climbText(c, ladder)}</p>
                    <p className="text-ink-300">
                      {counted(c.things.length, 'thing')} · mends {n(c.mends)}
                      {covered && <span className="text-[var(--color-atlas-route-ink)]"> · on {lower(w.walk)} from the {lower(w.place)}</span>}
                    </p>
                  </div>
                  {walk.steps && walk.change && !covered && (
                    <button type="button" aria-pressed={!!step} onClick={() => (step ? walk.change!({ remove: step.id }) : walk.change!({ add: stepOf(c, at, scope) }))} className={`btn min-h-11 shrink-0 md:min-h-8 ${step ? 'border-[var(--color-atlas-route)] text-[var(--color-atlas-route-ink)]' : 'btn-ghost'}`}>
                      {step ? 'On it' : 'Add'}
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
          {walk.steps && mended > 0 && (
            <p aria-live="polite" className="mt-2 text-[13px] text-ink-300">
              <span className="font-serif text-[26px] leading-none text-ink-50">
                <span className="text-red">{n(t.fail)}</span> → <span className={t.fail - mended ? 'text-red' : 'text-[var(--color-atlas-route-ink)]'}>{n(t.fail - mended)}</span>
              </span>{' '}
              broken here once {lower(w.walk)} is done.
            </p>
          )}
        </section>
      )}
      {own && p && (
        <p className="mt-4 text-[13px] text-ink-300">
          <Link to={ctx.route({ at: null, plot: p.key })} className="inline-flex min-h-11 items-center text-ink-100 underline underline-offset-4 md:min-h-0">
            Its own checks
          </Link>
          : {own.fail ? <span className="text-red">{n(own.fail)} broken</span> : 'none broken'} of {n(own.pass + own.fail + own.unknown)}.
        </p>
      )}
      {able.length > 0 && (
        <section>
          <PanelHead title={WORDS.hands} />
          <div className="flex flex-wrap gap-2">
            {walkTicks.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(walkTicks, true)}>
                Tick the {n(walkTicks.length)} on {lower(w.walk)}
              </button>
            )}
            {brokenThings.length > 0 && (
              <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(brokenThings, true)}>
                Tick the {n(brokenThings.length)} with a broken check
              </button>
            )}
            <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => ctx.tick(able, true)}>
              Tick all {n(able.length)}
            </button>
          </div>
        </section>
      )}
    </>
  )
  return <Shell crumbs={ctx.crumbs} stage={stage} over={ctx.lens(things)} panel={panel} peek={ctx.peekCard} tray={ctx.tray} scrolls legend={flowerKey(w, ladders)} tour={{ id: 'map', steps: MAP_TOUR }} />
}
