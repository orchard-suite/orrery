// The ground: one blueprint's entities, read for how each is doing against
// the numbers its estate set. It is the layer under the sky: the sky says
// what there is, the ground says how it is growing. A ground is drawn as an
// archipelago, one cell an entity, one island the folder its keys share, and
// it asks one question at a time: a lens, any broken budget or one budget
// alone. A cell outside what the lens asks stands in a storm, one inside it
// lies calm, and one with no number for it lies in fog; the verdict, the
// counts, and the gold route of the rounds follow the lens. A click on a cell
// opens a peek of the entity behind it. One entity's page is its bed. The
// page is a preview: only the people an admin named reach it.

import { ChevronRight, ExternalLink } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { GroundItemResponse, GroundResponse } from '../../shared/api.ts'
import type { BlueprintNamer, StatusLevel } from '../../shared/model.ts'
import { lensOf, lensState, lensTrend, plain, type GroundBehind, type GroundBehindRow, type GroundItem, type GroundLink, type GroundMeasure, type GroundRound } from '../../shared/ground.ts'
import { useBlueprintName, useBlueprints, useGround, useGroundItem, usePreview, useWhoAmI } from '../api.ts'
import { archipelagoOf, fanOut, folderName, lineHits, nearestOn, routeOrder, hexCorner, islandCoast, placeLabels, type Archipelago, type Box, type Point } from '../atlas.ts'
import { when } from '../format.ts'
import { breaksText, budgetText, checkText, foldText, counted, crossingText, dueDay, fixText, goalText, itemText, nameBeside, percent, sharedStart, standing, toFix, trendText, valueText, weekText, WORDS, type GroundWord, type ToFix } from '../ground.ts'
import { BlueprintIcon, Icon } from '../icons.tsx'
import { navigate } from '../router.ts'
import { Alarm, Crumbs, LensPicker, NameText, PanelHead, PeekCard, Quiet, Ranked, Shell, SkyBand, textWidth, Tip, TipTitle, useSize, useTip, Verdict, WeatherDefs, type CoachStep, type KeyMark, type LensOption, type RankRow } from './Atlas.tsx'
import { AtlasSky } from './AtlasSky.tsx'
import { BedArt, FenceGlyph } from './GroundArt.tsx'
import { HandsTray, tickable, tickId, useTicks, type Tickable } from './Hands.tsx'
import { Orbit } from './Orbit.tsx'
import { TrendChart } from './Trend.tsx'
import { Badge, Empty, ErrorNote, Lamp, LEVEL_NAME, Link, Panel, useDesk } from './ui.tsx'
import { useHere } from '../trail.ts'

const quiet = 'text-[13px] text-ink-400'
/** A link a finger can hit on a phone; on a desk it sits in its line of text. */
const tap = 'inline-flex min-h-11 items-center md:min-h-0'

/** A kind's ground on a first visit, in three steps. */
const GROUND_TOUR: CoachStep[] = [
  { at: 'stage', title: 'Each cell is one of them', says: 'An island is the folder its keys share. A storm hangs over a cell outside a budget; fog lies where there is no number.' },
  { at: 'panel', title: 'Click a cell to peek', says: 'Its numbers against their budgets open here. The rounds list where to go first.' },
  { at: 'over', title: 'Ask one thing at a time', says: 'The lens redraws the map, the counts, and the route for one budget alone. The ? holds the key.' },
]
const n = (v: number) => v.toLocaleString('en-US')

export function GroundPage({ blueprint, entityKey }: { blueprint: string | null; entityKey?: string }) {
  const me = useWhoAmI()
  const open = usePreview('garden')
  if (!me.data) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  if (!open)
    return (
      <div className="py-12">
        <Empty>There is nothing at this address.</Empty>
      </div>
    )
  if (blueprint === null) return <AtlasSky />
  return entityKey ? <Bed blueprint={blueprint} entityKey={entityKey} /> : <GroundOf blueprint={blueprint} />
}

/** A part of a bed under its name. */
function Part({ part, heading, action, children }: { part: GroundWord; heading?: string; action?: React.ReactNode; children: React.ReactNode }) {
  const id = `ground-${part}`
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-[15px] font-semibold text-ink-50">
            {heading ?? WORDS[part]}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function GroundOf({ blueprint }: { blueprint: string }) {
  const ground = useGround(blueprint)
  const [ticked, tick, clear] = useTicks()
  const [picked, setPicked] = useState<string | null>(null)
  // The budget the ground is read by: one field, or null for any broken budget.
  const [asked, setAsked] = useState<string | null>(null)
  // A cell a keyboard reader stands on: it is ringed on the map.
  const [focused, setFocused] = useState<string | null>(null)
  const [tip, showTip, hideTip] = useTip()
  if (ground.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const g = ground.data
  if (!g)
    return (
      <div className="py-12">
        <ErrorNote error={ground.error ?? 'This ground could not be read.'} />
      </div>
    )
  const items = g.items
  const budgeted = g.fields.filter((f) => f.budget)
  const field = budgeted.find((f) => f.field === asked) ?? null
  const lens = lensOf(items, field?.field ?? null)
  // The rounds in walking order, island by island, so the route on the map never doubles back.
  const walk = routeOrder(lens.rounds, items)
  const over = items.filter((i) => lensState(i, lens.field) === 'over')
  const canTick = tickable(items)
  const asTick = (i: GroundItem): Tickable => ({ blueprint: g.blueprint, key: i.key, title: i.title, actions: i.actions })
  const tickAll = (list: GroundItem[]) =>
    tick(
      list.filter((i) => i.actions.length).map((i) => tickId(asTick(i))),
      true,
    )
  const chosen = items.filter((i) => ticked.has(tickId(asTick(i)))).map(asTick)
  const item = picked ? items.find((i) => i.key === picked) : undefined
  const trial = items.filter((i) => i.trial)
  const judged = lens.over + lens.inside
  const asks = field ? field.title : 'any budget'
  const trend = trendText(lens.trend)
  const crumbs = <Crumbs steps={[{ label: WORDS.sky, to: { page: 'ground', blueprint: null } }, { label: g.title }]} />
  if (items.length === 0)
    return (
      <div className="py-5">
        {crumbs}
        <div className="mt-6">
          <Empty>Nothing here yet.</Empty>
        </div>
      </div>
    )
  const stage = (
    <figure className="m-0 desk:absolute desk:inset-0">
      <Islands ground={g} rounds={walk} lens={lens.field} ticked={ticked} picked={picked} focused={focused} onPick={(i) => setPicked(i ? i.key : null)} showTip={showTip} hideTip={hideTip} />
      <figcaption className="sr-only">
        {g.title}, read by {asks}: {counted(lens.over, WORDS.item)} {WORDS.storm}, {n(lens.inside)} inside, {n(lens.none)} {WORDS.fog}.
      </figcaption>
      {/* Every cell by name, for a keyboard and a screen reader: the one stood on is ringed on the map. */}
      <ul className="sr-only">
        {items.map((i) => (
          <li key={i.key}>
            <button type="button" onFocus={() => setFocused(i.key)} onBlur={() => setFocused(null)} onClick={() => setPicked(i.key)}>
              {itemText(i, LEVEL_NAME[i.level])}
            </button>
          </li>
        ))}
      </ul>
    </figure>
  )
  const peek = item && (
    <PeekCard
      kicker={g.title}
      title={item.title}
      level={item.level}
      reasons={item.reasons}
      entity={{ blueprint, key: item.key }}
      open={{ to: { page: 'ground', blueprint, key: item.key }, label: `Open its ${WORDS.item}` }}
      links={item.links}
      tick={item.actions.length ? { on: ticked.has(tickId(asTick(item))), set: (on) => tick([tickId(asTick(item))], on), label: 'Tick it, to run one action on several' } : undefined}
      onClose={() => setPicked(null)}
    >
      <ul className="mt-2.5 space-y-1 text-[13px] leading-snug text-ink-300">
        {item.measures.map((m) => (
          <li key={m.field}>
            {m.title}: <b className={`font-medium ${m.over ? 'text-red' : 'text-ink-100'}`}>{m.value === null ? 'not known' : plain(m.value)}</b>
            {m.budget ? (
              <span>
                {' '}
                · {m.value === null ? 'budget' : `${standing(m)} of`} {budgetText(m.budget)}
              </span>
            ) : (
              <span className="text-ink-400"> · no budget</span>
            )}
            {weekText(m) && <span className="text-ink-400"> · {weekText(m)}</span>}
          </li>
        ))}
      </ul>
      {item.why.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[12px] font-medium text-red">Why it is broken</p>
          <ul className="mt-0.5 space-y-0.5 text-[13px] leading-snug text-ink-100">
            {item.why.map((y) => (
              <li key={y}>{y}</li>
            ))}
          </ul>
        </div>
      )}
    </PeekCard>
  )
  // The rounds as the panel's ranked list: each stop by its number on the gold route, with why it is one.
  const rows: RankRow[] = walk.map((r, i) => {
    const it = items.find((x) => x.key === r.key)
    const id = it ? tickId(asTick(it)) : null
    return {
      id: r.key,
      title: r.title,
      says: r.why.join('; '),
      broken: walk.length - i,
      picked: picked === r.key,
      onPick: () => setPicked(picked === r.key ? null : r.key),
      onPoint: (on) => setFocused(on ? r.key : null),
      mark: (
        <span role="img" aria-label={`Stop ${i + 1}`} className="inline-grid size-5 place-items-center rounded-full bg-[var(--color-atlas-route)] text-[12px] font-bold text-ink-950">
          {i + 1}
        </span>
      ),
      after:
        id && it!.actions.length > 0 ? (
          <label className="inline-flex size-11 shrink-0 items-center justify-center md:size-8">
            <input type="checkbox" className="size-4" aria-label={`Tick ${r.title}`} checked={ticked.has(id)} onChange={(e) => tick([id], e.target.checked)} />
          </label>
        ) : undefined,
    }
  })
  const panel = (
    <>
      <Verdict kicker={`${WORDS.sky} · ${g.title}`}>
        {budgeted.length === 0 ? (
          <>
            {counted(items.length, WORDS.item)} with no budget to hold. <Quiet>All of it {WORDS.fog}.</Quiet>
          </>
        ) : field ? (
          <>
            {lens.over ? <Alarm>{n(lens.over)}</Alarm> : 'None'} of {n(judged)} outside {field.title}. {lens.none > 0 && <Quiet>{n(lens.none)} with no number.</Quiet>}
          </>
        ) : (
          <>
            {n(lens.inside)} of {n(judged)} inside every budget.{' '}
            {lens.over > 0 ? (
              <Quiet>
                <Alarm>{n(lens.over)}</Alarm> {WORDS.storm}.
              </Quiet>
            ) : (
              <Quiet>None {WORDS.storm}.</Quiet>
            )}
          </>
        )}
      </Verdict>
      <SkyBand t={{ fail: lens.over, unknown: lens.none, pass: lens.inside }} className="mt-5" words={{ broken: 'outside', nodata: 'no number', holding: 'inside' }} />
      {trend && <p className="mt-3 text-[13px] text-ink-300">{trend[0]!.toUpperCase() + trend.slice(1)}.</p>}
      {rows.length > 0 && (
        <section>
          <PanelHead title={WORDS.rounds} />
          <Ranked label="Where to go first" rows={rows} />
        </section>
      )}
      {canTick && over.some((i) => i.actions.length) && (
        <section>
          <PanelHead title={WORDS.hands} />
          <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => tickAll(over)}>
            Tick the {n(over.filter((i) => i.actions.length).length)} {WORDS.storm}
          </button>
        </section>
      )}
      {(g.templates.length > 0 || g.plant || trial.length > 0) && <Templates ground={g} trial={trial} />}
      {(g.forecast.crossings.length > 0 || g.forecast.ahead.length > 0) && <Forecast ground={g} />}
      {g.seasons.length > 0 && (
        <section>
          <PanelHead title={WORDS.seasons} />
          <Seasons ground={g} />
        </section>
      )}
      <p className="mt-6 text-[13px] text-ink-300">
        {g.read < g.total && `The first ${n(g.read)} of ${n(g.total)}. `}
        <Link to={{ page: 'inventory', blueprint }} className="inline-flex min-h-11 items-center text-ink-100 underline underline-offset-4 md:min-h-0">
          Every {g.title.toLowerCase()} as a grid
        </Link>
      </p>
    </>
  )
  // The lens: every budget is a check a reader may ask of the map alone.
  const options: LensOption[] = budgeted.map((f) => ({ id: f.field, title: f.title, broken: items.filter((i) => lensState(i, f.field) === 'over').length, nodata: items.filter((i) => lensState(i, f.field) === 'none').length }))
  const sw = (style: React.CSSProperties) => <i aria-hidden className="inline-block h-3 w-3.5 shrink-0 rounded-[3px]" style={style} />
  const legend: KeyMark[] = [
    { mark: sw({ background: 'radial-gradient(circle, var(--color-red) 0, var(--color-atlas-storm) 55%, transparent 80%)' }), word: 'outside', says: `A storm: a ${WORDS.item} outside the budget the lens asks about, or any budget.` },
    { mark: sw({ background: 'var(--color-atlas-field)' }), word: 'inside', says: 'Calm land: inside it.' },
    { mark: sw({ background: 'repeating-linear-gradient(-40deg, var(--color-atlas-fog) 0 2px, var(--color-atlas-bare) 2px 6px)' }), word: 'no number', says: 'Fog: no number to judge. It is never read as inside.' },
    ...(walk.length ? [{ mark: <i aria-hidden className="inline-block h-0 w-4 border-t-2 border-dotted border-[var(--color-atlas-route)]" />, word: 'rounds', says: 'The gold route: where to go first, stop by stop. Each island is the folder its keys share.' }] : []),
  ]
  return (
    <>
      <Shell crumbs={crumbs} stage={stage} over={options.length ? <LensPicker options={options} picked={lens.field} onPick={setAsked} /> : undefined} panel={panel} peek={peek || undefined} legend={legend} tour={{ id: 'ground', steps: GROUND_TOUR }} tray={<HandsTray chosen={chosen} noun={[g.title.toLowerCase(), `${g.title.toLowerCase()} entities`]} onClear={clear} />} />
      <Tip tip={tip} />
    </>
  )
}

/** The archipelago itself: islands of hex cells, storms and fog over them, the route of the rounds, and the islands' names off to one side. */
function Islands({ ground, rounds, lens, ticked, picked, focused, onPick, showTip, hideTip }: { ground: GroundResponse; rounds: GroundRound[]; lens: string | null; ticked: ReadonlySet<string>; picked: string | null; focused: string | null; onPick: (item: GroundItem | null) => void; showTip: (e: { clientX: number; clientY: number }, body: ReactNode) => void; hideTip: () => void }) {
  const [ref, width, height] = useSize<HTMLDivElement>()
  const desk = useDesk()
  // What the stage is shaped like: its own shape on a desk; a phone takes the archipelago tall, a tablet wide.
  const aspect = desk && height ? width / height : width > 0 && width < 600 ? 0.6 : 1.4
  // Worst on the lens first, so the cells in a storm gather at the middle of their island.
  const ordered = useMemo(() => {
    const rank = { over: 0, inside: 1, none: 2 } as const
    return [...ground.items].sort((a, b) => rank[lensState(a, lens)] - rank[lensState(b, lens)] || b.over - a.over || a.title.localeCompare(b.title))
  }, [ground.items, lens])
  // The islands spread wide, tall, or taller still: whichever is drawn largest on a stage of this shape, so the map fills what it is given.
  const spreads = useMemo(() => [archipelagoOf(ordered), archipelagoOf(ordered, { tall: true }), archipelagoOf(ordered, { long: true })], [ordered])
  const arch = spreads.reduce((best, a) => (Math.min(aspect / a.box[2], 1 / a.box[3]) > Math.min(aspect / best.box[2], 1 / best.box[3]) ? a : best))
  const coast = useMemo(() => islandCoast(arch), [arch])
  const [bx, by, bw, bh] = arch.box
  // The picture is fitted whole into the stage; on a phone it is as wide as the page and as tall as it needs.
  const scale = desk && height ? Math.min((width || 800) / bw, height / bh) : (width || 800) / bw
  const stateOf = (it: GroundItem) => lensState(it, lens)
  /** How many of the numbers the lens reads are outside their budget. */
  const breaks = (it: GroundItem) => it.measures.filter((m) => m.over && (lens === null || m.field === lens)).length
  const s = arch.s
  // A stop's badge and its number never draw under 12px of type on screen, however small the islands are drawn.
  const type = Math.max(s * 0.95, 12 / scale)
  const dot = Math.max(s * 0.82, 10 / scale)
  const poly = (x: number, y: number, k: number) =>
    [0, 1, 2, 3, 4, 5]
      .map((i) =>
        hexCorner(x, y, s * k, i)
          .map((v) => v.toFixed(1))
          .join(','),
      )
      .join(' ')
  const roundAt = new Map(rounds.map((r, i) => [r.key, i + 1]))
  const stops = useMemo(() => rounds.flatMap((r) => arch.cells.find((c) => c.item.key === r.key) ?? []), [rounds, arch])
  // Stops that follow one another on a crowded spot are one knot: one badge naming the run ("3-8"), which fans out on hover or a tap.
  const knots = useMemo(() => {
    const out: { from: number; to: number }[] = []
    stops.forEach((c, i) => {
      const last = out.at(-1)
      const head = last ? stops[last.from]! : null
      if (last && last.to === i - 1 && head && Math.hypot(c.x - head.x, c.y - head.y) < s * 4.2 && Math.hypot(c.x - stops[i - 1]!.x, c.y - stops[i - 1]!.y) < s * 3.2) last.to = i
      else out.push({ from: i, to: i })
    })
    // A run of two stays two badges, fanned apart; three or more are a knot.
    return out.flatMap((k) => (k.to - k.from >= 2 ? [k] : Array.from({ length: k.to - k.from + 1 }, (_, j) => ({ from: k.from + j, to: k.from + j }))))
  }, [stops, s])
  // A knot shows its stops fanned out, each numbered on its own short line; a click folds it into one badge and back.
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set())
  const knotAt = knots.map((k): Point => {
    const run = stops.slice(k.from, k.to + 1)
    return [run.reduce((a, c) => a + c.x, 0) / run.length, run.reduce((a, c) => a + c.y, 0) / run.length]
  })
  // Each lone stop's number sits on its own cell, fanned from a neighbour that crowds it, so the route reads from badge to badge.
  const fanned = fanOut(
    stops.map((c): Point => [c.x, c.y]),
    dot * 2.3,
  )
  // A knot's stops fan out to just past its island's shore, in route order round it, starting where the route comes in, each on a short line back to its cell.
  const shoreOf = (k: { from: number; to: number }): { c: Point; R: number; at: Point[]; turn: number } => {
    const island = stops[k.from]!.island
    const cells = arch.cells.filter((c) => c.island === island)
    const c: Point = [cells.reduce((acc, x) => acc + x.x, 0) / cells.length, cells.reduce((acc, x) => acc + x.y, 0) / cells.length]
    const R = Math.max(...cells.map((x) => Math.hypot(x.x - c[0], x.y - c[1]))) + s + dot * 1.3
    const from: Point = k.from > 0 ? [stops[k.from - 1]!.x, stops[k.from - 1]!.y] : [stops[k.from]!.x, stops[k.from]!.y - 1]
    let a0 = Math.atan2(from[1] - c[1], from[0] - c[0])
    // Turn the way that brings the run toward the next stop after it, so the route leaves the island near where it goes next.
    const next = k.to + 1 < stops.length ? Math.atan2(stops[k.to + 1]!.y - c[1], stops[k.to + 1]!.x - c[0]) : a0 + 1
    const turn = Math.sin(next - a0) >= 0 ? 1 : -1
    // At least 26px apart on screen, wherever they are drawn.
    const step = Math.max(dot * 2.5, 26 / scale) / R
    // The first stop on the shore keeps the same gap from the badge of the stop before it, so the two never crowd.
    const prev = k.from > 0 ? fanned[k.from - 1]! : null
    for (let tries = 0; prev && tries < 40 && Math.hypot(c[0] + Math.cos(a0) * R - prev[0], c[1] + Math.sin(a0) * R - prev[1]) < Math.max(dot * 2.5, 26 / scale); tries++) a0 += turn * step * 0.5
    const at = Array.from({ length: k.to - k.from + 1 }, (_, j): Point => {
      const ang = a0 + turn * j * step
      return [c[0] + Math.cos(ang) * R, c[1] + Math.sin(ang) * R]
    })
    return { c, R, at, turn }
  }

  // The route as drawn, badge to badge: no island's name may sit across it.
  const routePts = knots.flatMap((k): Point[] => (k.from === k.to ? [fanned[k.from]!] : shoreOf(k).at))
  const labels = islandLabels(
    arch,
    (cells) => trendText(lensTrend(cells, lens)),
    scale,
    // Every badge keeps the islands' names off it: a lone stop's, and each of a knot's on its island's shore.
    knots.flatMap((k) => {
      if (k.from === k.to) {
        const [x, y] = fanned[k.from]!
        return [{ x: x - dot, y: y - dot, w: 2 * dot, h: 2 * dot }]
      }
      return shoreOf(k).at.map(([x, y]) => ({ x: x - dot * 1.2, y: y - dot * 1.2, w: 2.4 * dot, h: 2.4 * dot }))
    }),
    routePts,
  )
  // The hover card reads the cell aloud: each number the lens asks about against its budget, then where it stands.
  const tipOf = (it: GroundItem): ReactNode => (
    <>
      <TipTitle>{it.title}</TipTitle>
      {it.measures
        .filter((m) => m.budget && (lens === null || m.field === lens))
        .map((m) => (
          <span key={m.field} className="block">
            {m.title} {m.value === null ? 'not known' : plain(m.value)}, budget {budgetText(m.budget)}
            {m.over && <b className="font-medium text-red">: outside</b>}
          </span>
        ))}
      <span className="block text-ink-300">{[stateOf(it) === 'over' ? 'In a storm' : stateOf(it) === 'none' ? 'In fog: no number' : 'Inside', roundAt.has(it.key) ? `stop ${roundAt.get(it.key)}` : ''].filter(Boolean).join(' · ')}</span>
    </>
  )
  const cellAt = (e: React.PointerEvent | React.MouseEvent) => {
    const i = (e.target as Element).getAttribute?.('data-cell')
    return i === null || i === undefined ? null : arch.cells[Number(i)]
  }
  return (
    <div ref={ref} className="w-full overflow-hidden rounded-2xl border border-ink-800 desk:size-full desk:rounded-none desk:border-0" style={{ background: 'var(--color-atlas-space)' }}>
      <svg viewBox={`${bx} ${by} ${bw} ${bh}`} className="block h-auto w-full desk:size-full" role="group" aria-label={`Every ${ground.title.toLowerCase()} as a cell of land, grouped by the folder of its key. Storms hang over those outside ${lens === null ? 'a budget' : 'the budget asked about'}, fog over those with no number to judge.`}>
        <defs>
          <WeatherDefs id="isles" />
          <pattern id="isles-sea" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="var(--color-atlas-space)" />
            <path d="M0 6q3 -2 6 0t6 0" stroke="var(--color-atlas-sea)" strokeOpacity={0.5} fill="none" />
          </pattern>
        </defs>
        {/* The sea runs past the picture's own box, so it fills a stage of any shape. */}
        <rect x={bx - bw * 2} y={by - bh * 2} width={bw * 5} height={bh * 5} fill="url(#isles-sea)" aria-hidden onClick={() => onPick(null)} />
        <g aria-hidden pointerEvents="none" filter="url(#isles-soft)" opacity={0.6}>
          {arch.cells.map((c, i) => (
            <polygon key={i} points={poly(c.x, c.y, 1.25)} fill="var(--color-atlas-shallows)" />
          ))}
        </g>
        <g
          className="cursor-pointer"
          onPointerMove={(e) => {
            const c = cellAt(e)
            if (c) showTip(e, tipOf(c.item))
            else hideTip()
          }}
          onPointerLeave={hideTip}
          onClick={(e) => {
            const c = cellAt(e)
            onPick(c ? (c.item.key === picked ? null : c.item) : null)
          }}
          onDoubleClick={(e) => {
            const c = cellAt(e)
            if (c)
              navigate({
                page: 'ground',
                blueprint: ground.blueprint,
                key: c.item.key,
              })
          }}
        >
          {arch.cells.map((c, i) => {
            const st = stateOf(c.item)
            const fill = st === 'over' ? 'color-mix(in oklab, var(--color-red) 22%, var(--color-atlas-wild))' : st === 'none' ? 'var(--color-atlas-bare)' : 'var(--color-atlas-field)'
            return <polygon key={c.item.key} data-cell={i} className="atlas-cell" points={poly(c.x, c.y, 0.97)} fill={fill} stroke={st === 'over' ? 'var(--color-atlas-storm)' : 'var(--color-atlas-field-edge)'} strokeWidth={0.8} />
          })}
        </g>
        <g aria-hidden pointerEvents="none">
          <g filter="url(#isles-storm)">{arch.cells.map((c, i) => (stateOf(c.item) === 'over' ? <circle key={i} cx={c.x} cy={c.y} r={s * (1.2 + 0.35 * breaks(c.item))} fill="var(--color-red)" opacity={0.22 + 0.1 * breaks(c.item)} /> : null))}</g>
          <mask id="isles-fogmask" maskUnits="userSpaceOnUse" x={bx} y={by} width={bw} height={bh}>
            <g filter="url(#isles-storm)">{arch.cells.map((c, i) => (stateOf(c.item) === 'none' ? <circle key={i} cx={c.x} cy={c.y} r={s * 1.15} fill="#fff" opacity={0.5} /> : null))}</g>
          </mask>
          <rect x={bx} y={by} width={bw} height={bh} fill="url(#isles-fog)" mask="url(#isles-fogmask)" />
          <path d={coast} fill="none" stroke="var(--color-atlas-coast)" strokeOpacity={0.6} strokeWidth={1} />
          {arch.cells.map((c, i) => (c.item.key === picked || c.item.key === focused ? <polygon key={`l${i}`} points={poly(c.x, c.y, 1.05)} fill="none" stroke="var(--color-ink-50)" strokeWidth={2.4 / Math.max(0.5, scale)} /> : null))}
          {arch.cells.map((c, i) =>
            ticked.has(`${ground.blueprint}:${c.item.key}`) ? (
              <g key={i}>
                <polygon points={poly(c.x, c.y, 0.92)} fill="color-mix(in oklab, var(--color-orbit) 25%, transparent)" stroke="var(--color-orbit)" strokeWidth={2} />
                <path d={`M${c.x - 3.5} ${c.y}l2.5 2.6l5 -5.2`} stroke="var(--color-ink-50)" strokeWidth={1.8} fill="none" />
              </g>
            ) : null,
          )}
          {(() => {
            // The route: badge to badge; through an opened knot it runs round the island's shore, never across it.
            let d = ''
            knots.forEach((k, ki) => {
              if (k.from === k.to || folded.has(ki)) {
                const [x, y] = k.from === k.to ? [stops[k.from]!.x, stops[k.from]!.y] : knotAt[ki]!
                d += `${d ? 'L' : 'M'}${x} ${y}`
                return
              }
              const sh = shoreOf(k)
              sh.at.forEach(([x, y], j) => {
                d += j === 0 ? `${d ? 'L' : 'M'}${x} ${y}` : `A${sh.R} ${sh.R} 0 0 ${sh.turn > 0 ? 1 : 0} ${x} ${y}`
              })
            })
            return d.includes('L') || d.includes('A') ? (
              <>
                <path d={d} fill="none" stroke="var(--color-ink-950)" strokeOpacity={0.85} strokeWidth={5 / scale} strokeLinecap="round" strokeLinejoin="round" />
                <path d={d} fill="none" stroke="var(--color-atlas-route)" strokeWidth={2.4 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} strokeLinecap="round" strokeLinejoin="round" />
              </>
            ) : null
          })()}
        </g>
        <g aria-hidden>
          {knots.map((k, ki) => {
            // `toward` is the island's middle for a stop on the shore: it gets a short tick pointing in, never a line across the island.
            const badge = (i: number, [bx, by]: Point, from: Point | null, toward: Point | null = null) => (
              <g key={stops[i]!.item.key}>
                {from && !toward && <line x1={from[0]} y1={from[1]} x2={bx} y2={by} stroke="var(--color-atlas-route)" strokeWidth={1.4 / scale} />}
                {from && <circle cx={from[0]} cy={from[1]} r={s * 0.3} fill="var(--color-atlas-route)" />}
                {toward &&
                  (() => {
                    const len = Math.hypot(toward[0] - bx, toward[1] - by) || 1
                    const tick = dot + s * 1.1
                    return <line x1={bx} y1={by} x2={bx + ((toward[0] - bx) / len) * tick} y2={by + ((toward[1] - by) / len) * tick} stroke="var(--color-atlas-route)" strokeWidth={2 / scale} strokeLinecap="round" />
                  })()}
                <circle cx={bx} cy={by} r={dot} fill="var(--color-atlas-route)" stroke="var(--color-ink-950)" strokeWidth={1.5 / scale} />
                <text x={bx} y={by + type * 0.36} textAnchor="middle" fontSize={type} fontWeight={700} fill="currentColor" className="text-ink-950">
                  {i + 1}
                </text>
              </g>
            )
            if (k.from === k.to) {
              const c = stops[k.from]!
              const at = fanned[k.from]!
              return (
                <g key={c.item.key} pointerEvents="none">
                  {badge(k.from, at, Math.hypot(at[0] - c.x, at[1] - c.y) > 1 ? [c.x, c.y] : null)}
                </g>
              )
            }
            const at = knotAt[ki]!
            const label = `${k.from + 1}-${k.to + 1}`
            const w = textWidth(label, 12, 700) / scale + 2 * dot * 0.7
            return (
              <g key={`knot${k.from}`} className="cursor-pointer" onClick={(e) => (e.stopPropagation(), setFolded(folded.has(ki) ? new Set([...folded].filter((x) => x !== ki)) : new Set([...folded, ki])))}>
                {!folded.has(ki) ? (
                  <>
                    {(() => {
                      const sh = shoreOf(k)
                      return sh.at.map((p, j) => badge(k.from + j, p, [stops[k.from + j]!.x, stops[k.from + j]!.y], sh.c))
                    })()}
                  </>
                ) : (
                  <>
                    <rect x={at[0] - w / 2} y={at[1] - dot} width={w} height={dot * 2} rx={dot} fill="var(--color-atlas-route)" stroke="var(--color-ink-950)" strokeWidth={1.5 / scale} />
                    <text x={at[0]} y={at[1] + type * 0.36} textAnchor="middle" fontSize={type} fontWeight={700} fill="currentColor" className="text-ink-950">
                      {label}
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </g>
        <g pointerEvents="none">
          {labels.map((l) =>
            l.box ? (
              <g key={l.island}>
                <line x1={l.anchor[0]} y1={l.anchor[1]} x2={l.end[0]} y2={l.end[1]} stroke="var(--color-ink-200)" strokeOpacity={0.7} strokeWidth={1.2 / scale} />
                <text x={l.box.x + l.box.w / 2} y={l.box.y + l.size * 0.9} textAnchor="middle" fontSize={l.size} fill="currentColor" className="atlas-halo font-serif text-ink-50" strokeWidth={6 / scale}>
                  {l.name}
                </text>
                {l.sub && (
                  <text x={l.box.x + l.box.w / 2} y={l.box.y + l.size * 2.1} textAnchor="middle" fontSize={12 / scale} fill="currentColor" className="atlas-halo text-ink-200" strokeWidth={5 / scale}>
                    {l.sub}
                  </text>
                )}
              </g>
            ) : null,
          )}
        </g>
      </svg>
    </div>
  )
}

/** Each island's name, off the land on a callout with a line back to it, where it runs into no other name and no land. Small islands of the few go unnamed. */
function islandLabels(
  arch: Archipelago<GroundItem>,
  subOf: (items: GroundItem[]) => string,
  scale: number,
  marks: Box[],
  route: readonly Point[] = [],
): {
  island: number
  name: string
  /** How the island moved since last week, under its name. Empty where no past is kept. */
  sub: string
  size: number
  anchor: Point
  end: Point
  box: Box | null
}[] {
  const s = arch.s
  const lands: Box[] = arch.cells.map((c) => ({
    x: c.x - s,
    y: c.y - s,
    w: 2 * s,
    h: 2 * s,
  }))
  const named = arch.islands
    .map((isl, i) => ({
      isl,
      i,
      cells: arch.cells.filter((c) => c.island === i),
    }))
    .filter(({ cells }) => cells.length > 0)
  // The size it is drawn at on screen, and never under the floor where the picture is drawn larger than its units.
  // Every island's name is one size on screen: 14, or 12 on a phone.
  const size = (_k: number) => (scale < 0.6 ? 13 : 14) / scale
  const rows = named.map(({ isl, i, cells }) => {
    const name = isl.folder === null ? 'The scattered isles' : folderName(isl.folder)
    const sub = subOf(cells.map((c) => c.item))
    const fs = size(cells.length)
    const w = Math.max(textWidth(name, scale < 0.6 ? 13 : 14, 400) * 0.9, sub ? textWidth(sub, 12, 400) : 0) / scale + 12
    const h = fs * (sub ? 2.5 : 1.35)
    const xs = cells.map((c) => c.x)
    const ys = cells.map((c) => c.y)
    const [x0, x1, y0, y1] = [Math.min(...xs) - s, Math.max(...xs) + s, Math.min(...ys) - s, Math.max(...ys) + s]
    const mid = (x0 + x1) / 2
    const lift = 10 / Math.max(0.5, scale)
    const options: Box[] = [
      { x: mid - w / 2, y: y0 - h - lift, w, h },
      { x: mid - w / 2, y: y1 + lift, w, h },
      { x: x1 + lift, y: (y0 + y1) / 2 - h / 2, w, h },
      { x: x0 - lift - w, y: (y0 + y1) / 2 - h / 2, w, h },
      { x: mid - w / 2, y: y0 - h - lift * 3, w, h },
      { x: mid - w / 2, y: y1 + lift * 3, w, h },
      // Further out, so every island keeps its name where its own shores are crowded.
      ...[5, 8, 12].flatMap((k) => [
        { x: mid - w / 2, y: y0 - h - lift * k, w, h },
        { x: mid - w / 2, y: y1 + lift * k, w, h },
        { x: x1 + lift * k, y: (y0 + y1) / 2 - h / 2, w, h },
        { x: x0 - lift * k - w, y: (y0 + y1) / 2 - h / 2, w, h },
      ]),
    ]
    return {
      island: i,
      name,
      sub,
      size: fs,
      options,
      edge: cells.map((c): Point => [c.x, c.y]),
      cells: cells.length,
    }
  })
  const order = rows.map((_, k) => k).sort((a, b) => rows[b]!.cells - rows[a]!.cells)
  const [bx, by, bw, bh] = arch.box
  // A name whose line back would pass over another island's cell is left out of its choices, so every line plainly ends at its own island.
  const others = (island: number) => arch.cells.filter((c) => c.island !== island).map((c) => ({ x: c.x - s * 0.9, y: c.y - s * 0.9, w: s * 1.8, h: s * 1.8 }))
  for (const r of rows) {
    const theirs = others(r.island)
    r.options = r.options.filter((box) => {
      if (route.some((p, k) => k > 0 && lineHits(route[k - 1]!, p, box, 2))) return false
      const mid: Point = [box.x + box.w / 2, box.y + box.h / 2]
      const near = r.edge.reduce((a, c) => (Math.hypot(c[0] - mid[0], c[1] - mid[1]) < Math.hypot(a[0] - mid[0], a[1] - mid[1]) ? c : a), r.edge[0]!)
      return !theirs.some((o) => lineHits(near, nearestOn(box, near), o))
    })
  }
  const got = placeLabels(
    order.map((k) => rows[k]!.options),
    [...lands, ...marks],
    4,
    // Inside the frame with a margin, so no name is cut by its edge.
    { x: bx + s, y: by + s * 0.6, w: bw - 2 * s, h: bh - 1.2 * s },
  )
  const boxes = new Map(order.map((k, j) => [k, got[j]!]))
  return rows.map((r, k) => {
    const box = boxes.get(k) ?? null
    // The line runs from the cell nearest the name to the near side of the name's box, so it crosses no other cell of the island.
    const mid: Point = box ? [box.x + box.w / 2, box.y + box.h / 2] : [0, 0]
    const near = r.edge.reduce((a, c) => (Math.hypot(c[0] - mid[0], c[1] - mid[1]) < Math.hypot(a[0] - mid[0], a[1] - mid[1]) ? c : a), r.edge[0]!)
    const end: Point = box ? [Math.min(box.x + box.w, Math.max(box.x, near[0])), Math.min(box.y + box.h, Math.max(box.y, near[1]))] : near
    const toward = Math.hypot(end[0] - near[0], end[1] - near[1]) || 1
    const anchor: Point = [near[0] + ((end[0] - near[0]) / toward) * arch.s * 0.9, near[1] + ((end[1] - near[1]) / toward) * arch.s * 0.9]
    return { island: r.island, name: r.name, sub: r.sub, size: r.size, anchor, end, box }
  })
}

/** The templates things started from, and the trial. */
function Templates({ ground: g, trial }: { ground: GroundResponse; trial: GroundItem[] }) {
  const words = WORDS
  return (
    <section>
      <PanelHead title={words.templates} />
      {g.plant && (
        <Link to={{ page: 'actions', id: g.plant.action }} className="btn btn-solid mb-3 min-h-9" title={g.plant.title}>
          Plant one
        </Link>
      )}
      {g.templates.length > 0 && (
        <ul className="space-y-1">
          {g.templates.map((t) => (
            <li key={`${t.blueprint}:${t.key}`} className="text-[13px] text-ink-300">
              <Link to={{ page: 'entity', blueprint: t.blueprint, key: t.key }} className="font-medium text-ink-100 hover:underline">
                {t.title}
              </Link>{' '}
              at {t.current ?? 'a version not said'}: {counted(t.planted, 'started from it', 'started from it')}
              {t.behind > 0 && <span className="text-amber">, {n(t.behind)} on an older version</span>}.
            </li>
          ))}
        </ul>
      )}
      {trial.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-ink-300">
          <span className="font-medium text-ink-100">{words.trial}:</span>
          {trial.map((i) => (
            <Link key={i.key} to={{ page: 'ground', blueprint: g.blueprint, key: i.key }} className="inline-flex min-h-8 items-center rounded-full border border-orbit/50 px-2.5 text-ink-100 hover:border-orbit">
              {i.title}
            </Link>
          ))}
        </p>
      )}
    </section>
  )
}

/** Where the last weeks carry each number, and the dates that fall due. */
function Forecast({ ground: g }: { ground: GroundResponse }) {
  return (
    <section>
      <PanelHead title={WORDS.forecast} />
      <ul className="space-y-1.5 text-[13px] text-ink-300">
        {g.forecast.crossings.map((c) => (
          <li key={`${c.key}:${c.field}`}>
            <Link to={{ page: 'ground', blueprint: g.blueprint, key: c.key }} className="font-medium text-ink-100 hover:underline">
              {c.title}
            </Link>
            : {crossingText(c)}.
          </li>
        ))}
        {g.forecast.ahead.map((a) => (
          <li key={`${a.day}:${a.field}`}>
            <span className="font-medium text-ink-100">
              {dueDay(a.day)}: {a.title}
            </span>{' '}
            for{' '}
            {a.items.map((i, k) => (
              <span key={i.key}>
                {k > 0 && ', '}
                <Link to={{ page: 'ground', blueprint: g.blueprint, key: i.key }} className="text-ink-100 hover:underline">
                  {i.title}
                </Link>
              </span>
            ))}
            .
          </li>
        ))}
      </ul>
    </section>
  )
}

const weekDay = (week: string) =>
  new Date(`${week}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** The share inside every budget at the end of each week, as bars. The picture's name says the same. */
function Seasons({ ground }: { ground: GroundResponse }) {
  const weeks = ground.seasons
  const known = weeks.filter((w) => w.share !== null)
  const first = known[0]
  const last = known.at(-1)
  const says = first && last ? `Share inside every budget, by week: ${percent(first.share ?? 0)} in the week ending ${weekDay(first.week)}, ${percent(last.share ?? 0)} now` : 'No week has a number to read yet'
  return (
    <div role="img" aria-label={says} className="flex items-end gap-1.5">
      {weeks.map((w) => (
        <div key={w.week} className="min-w-0 flex-1" title={`Week ending ${weekDay(w.week)}: ${w.share === null ? 'not known' : `${percent(w.share)}, ${w.inside} of ${w.measured}`}`}>
          <div className="flex h-20 items-end rounded-sm bg-ink-800">{w.share !== null && <div className="w-full rounded-sm bg-signal-green" style={{ height: `${Math.max(w.share * 100, 2)}%` }} />}</div>
        </div>
      ))}
    </div>
  )
}

function Bed({ blueprint, entityKey }: { blueprint: string; entityKey: string }) {
  const bed = useGroundItem({ blueprint, key: entityKey })
  const blueprints = useBlueprints().data?.blueprints ?? []
  const namer = useBlueprintName()
  useHere(bed.data?.item.title)
  if (bed.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const d = bed.data
  if (!d)
    return (
      <div className="py-12">
        <ErrorNote error={bed.error ?? 'This could not be read.'} />
      </div>
    )
  const item = d.item
  const words = WORDS
  const bp = blueprints.find((b) => b.id === blueprint)
  // What a number is, as its field's description says it to a person.
  const about = (field: string) => bp?.fields[field]?.description ?? ''
  const behind = new Map((d.behind ?? []).map((b) => [b.field, b]))
  const fnOf = (field: string) => bp?.fields[field]?.aggregation?.fn ?? 'count'
  const fixes = toFix(item, d.guards, behind, fnOf)
  // A number or a check a card already says is not said again below it; a number with no value and no goal says nothing.
  const carded = new Set(fixes.flatMap((f) => (f.kind === 'measure' ? [f.measure.field] : f.kind === 'guard' ? [f.guard.field] : f.kind === 'thing' ? f.breaks.map((m) => m.field) : [])))
  const numbers = item.measures.filter((m) => !carded.has(m.field) && (m.value !== null || m.budget))
  const checks = d.guards.filter((g) => !carded.has(g.field))
  return (
    <div className="space-y-10 py-6 md:py-10">
      <header className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <Link to={{ page: 'ground', blueprint }} className={`${quiet} ${tap} hover:text-ink-100 hover:underline`}>
            {d.title}
          </Link>
          <h1 className="page-title mt-1 flex items-center gap-3">
            <Lamp level={item.level} size="lg" />
            <NameText name={item.title} />
          </h1>
          {!fixes.length && <p className="mt-3 text-[15px] text-ink-200">{fixText(fixes)}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            {item.trial && <Badge className="border-orbit/50 text-ink-100">{words.trial}</Badge>}
            <Link to={{ page: 'entity', blueprint, key: entityKey }} className={`${tap} text-ink-100 underline underline-offset-4`}>
              Open in the catalog
            </Link>
            {item.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={`${tap} text-ink-100 underline underline-offset-4`}>
                {l.title}
              </a>
            ))}
          </p>
        </div>
        <figure className="hidden w-40 shrink-0 rounded-lg border border-ink-700 bg-ink-900/70 p-2 lg:block">
          <BedArt item={item} className="block w-full" />
          <figcaption className="sr-only">{itemText(item, LEVEL_NAME[item.level])}</figcaption>
        </figure>
      </header>

      {fixes.length > 0 && (
        <Part part="fix" heading={fixText(fixes).replace(/\.$/, '')}>
          <ol className="space-y-3">
            {fixes.map((f) => (
              <Fix key={f.kind === 'thing' ? `${f.row.blueprint}:${f.row.key}` : f.kind === 'measure' ? f.measure.field : f.kind === 'guard' ? f.guard.field : f.reason} fix={f} owner={item.title} level={item.level} links={item.links} kind={namer} about={about} />
            ))}
          </ol>
        </Part>
      )}

      <div className="grid gap-10 lg:grid-cols-[3fr_2fr]">
        <Part part="measures">
          {numbers.length === 0 ? (
            <p className={quiet}>It holds no number the ground reads.</p>
          ) : (
            <ul className="divide-y divide-ink-700 border-y border-ink-700">
              {numbers.map((m) => (
                <li key={m.field} className="py-3">
                  <Reading m={m} about={about(m.field)} past={d.pasts[m.field]} />
                  <Behind behind={behind.get(m.field)} about={about(m.field)} fn={fnOf(m.field)} m={m} owner={item.title} kind={namer} />
                </li>
              ))}
            </ul>
          )}
        </Part>
        <div className="space-y-10">
          {checks.length > 0 && (
            <Part part="guards">
              <ul className="space-y-1.5">
                {checks.map((g) => (
                  <li key={g.field} className="flex items-center gap-2 text-sm">
                    <FenceGlyph on={g.on} />
                    <span className="min-w-0 flex-1 break-words text-ink-100">{g.title}</span>
                    <span className={g.on === null ? 'text-ink-400' : g.on ? 'text-ink-200' : 'font-medium text-red'}>{checkText(g.on)}</span>
                  </li>
                ))}
              </ul>
            </Part>
          )}
          {d.foundations.length > 0 && (
            <Part part="foundations">
              {/* The list comes deepest first; the picture stacks it with the deepest at the bottom. */}
              <ol className="flex flex-col-reverse overflow-hidden rounded-lg border border-ink-700">
                {d.foundations.map((f, i) => (
                  <li key={f.field} className={`flex items-baseline gap-3 px-3 py-2 text-sm ${i % 2 ? 'bg-ink-850' : 'bg-ink-800'}`}>
                    <span className="min-w-0 flex-1 break-words text-ink-300">{f.title}</span>
                    <span className="break-words text-ink-100">{f.value ?? 'Not said'}</span>
                  </li>
                ))}
              </ol>
            </Part>
          )}
          {item.template && (
            <section aria-labelledby="ground-template" className="space-y-2">
              <h2 id="ground-template" className="text-[15px] font-semibold text-ink-50">
                {words.template}
              </h2>
              <p className="text-sm text-ink-200">
                Started from{' '}
                <Link
                  to={{
                    page: 'entity',
                    blueprint: item.template.blueprint,
                    key: item.template.key,
                  }}
                  className="font-medium text-ink-100 underline underline-offset-4"
                >
                  {item.template.title}
                </Link>
                {item.template.version && ` at ${item.template.version}`}.{item.template.behind && <span className="text-amber"> It is now at {item.template.current}.</span>}
              </p>
            </section>
          )}
          {d.ahead.length > 0 && (
            <section aria-labelledby="ground-ahead" className="space-y-2">
              <h2 id="ground-ahead" className="text-[15px] font-semibold text-ink-50">
                Dates ahead
              </h2>
              <ul className="space-y-1 text-sm text-ink-200">
                {d.ahead.map((a) => (
                  <li key={a.field}>
                    <span className="text-ink-100">{a.title}</span>: {when(a.at)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {d.taught.length > 0 && (
        <Part part="taught">
          <div className="grid gap-6 lg:grid-cols-2">
            {d.taught.map((t, i) => (
              <Taught key={t.source ? `${t.source.blueprint}:${t.source.key}` : i} bed={d} taught={t} />
            ))}
          </div>
        </Part>
      )}
    </div>
  )
}

/** The links a fix offers, as buttons: where to go to mend it. */
function FixLinks({ links }: { links: GroundLink[] }) {
  if (!links.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="btn btn-ghost min-h-11 md:min-h-0">
          {l.title}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      ))}
    </div>
  )
}

/** One thing to fix: what it is, why in its own words, and where to go. What it does to the numbers is one short line. */
function Fix({ fix, owner, level, links, kind, about }: { fix: ToFix; owner: string; level: StatusLevel; links: GroundLink[]; kind: BlueprintNamer; about: (field: string) => string }) {
  // The stripe is the colour of what it says: a thing's own level, a broken number or check red, a status reason the entity's.
  const stripe = (l: StatusLevel) => (l === 'amber' ? 'border-l-amber' : 'border-l-red')
  const card = (l: StatusLevel) => `rounded-lg border border-l-[3px] border-ink-700 ${stripe(l)} bg-ink-900/70 px-4 py-3`
  if (fix.kind === 'thing') {
    const { row, breaks } = fix
    const name = nameBeside(row.title, owner)
    const of = kind(row.blueprint)
    return (
      <li className={card(breaks.length ? 'red' : row.level)} title={row.title}>
        <div className="flex items-baseline gap-2.5">
          <Lamp level={row.level} className="translate-y-px" />
          <Link to={{ page: 'entity', blueprint: row.blueprint, key: row.key }} className={`${tap} min-w-0 text-[15px] font-medium text-ink-50 underline-offset-4 hover:underline`}>
            <NameText name={name} />
          </Link>
          {of !== name && <span className="text-[13px] text-ink-400">{of}</span>}
        </div>
        <div className="pl-5">
          {row.reasons.length > 0 && <p className="mt-1 text-[15px] text-ink-100">{row.reasons.join('. ')}</p>}
          {breaks.length > 0 && <p className="mt-1 text-[13px] text-ink-400">{breaks.map((m) => breaksText(m)).join(' ')}</p>}
          <FixLinks links={row.links} />
        </div>
      </li>
    )
  }
  // What follows is about the entity itself, so it is mended at the entity's own addresses.
  if (fix.kind === 'measure') {
    const m = fix.measure
    return (
      <li className={card('red')}>
        <Reading m={m} about={about(m.field)} />
        {about(m.field) && <p className="mt-1 text-[13px] text-ink-300">{about(m.field)}</p>}
        <FixLinks links={links} />
      </li>
    )
  }
  if (fix.kind === 'guard')
    return (
      <li className={card('red')}>
        <div className="flex items-center gap-2.5">
          <FenceGlyph on={fix.guard.on} />
          <p className="text-[15px] font-medium text-ink-50">{fix.guard.title}</p>
          <span className="font-medium text-red">{checkText(fix.guard.on)}</span>
        </div>
        <FixLinks links={links} />
      </li>
    )
  return (
    <li className={card(level)}>
      <p className="text-[15px] text-ink-50">{fix.reason}</p>
      <FixLinks links={links} />
    </li>
  )
}

/** One number: its name, what it is in the words of its description, its value, and what it should be. */
function Reading({ m, about, past }: { m: GroundMeasure; about: string; past?: GroundItemResponse['pasts'][string] }) {
  const week = weekText(m)
  const goal = goalText(m.budget)
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink-100" title={about || undefined}>
            {m.title}
          </p>
          {week && <p className="text-[13px] text-ink-400">{`${week[0]!.toUpperCase()}${week.slice(1)}.`}</p>}
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-xl tabular-nums ${m.over ? 'font-semibold text-red' : 'text-ink-50'}`}>{m.value === null ? '—' : plain(m.value)}</div>
          {goal && m.over && <div className="text-[12px] text-red">{goal}</div>}
        </div>
      </div>
      {past && past.length > 1 && (
        <div className="mt-2">
          <TrendChart value={{ points: past }} />
        </div>
      )}
    </div>
  )
}

/** What a number says it is and the things it was worked out from, folded under it: for a count, only what it counted. */
function Behind({ behind, about, fn, m, owner, kind }: { behind: GroundBehind | undefined; about: string; fn: string; m: GroundMeasure; owner: string; kind: BlueprintNamer }) {
  if (!behind) return null
  const fold = foldText(behind, fn, kind(behind.rows[0]?.blueprint).toLowerCase())
  if (!fold) return null
  const rows = fn === 'count' ? behind.rows.filter((r) => r.counted !== false) : behind.rows
  // Lines that share a long start, such as a repository's path, show only what tells them apart.
  const start = sharedStart(rows.map((r) => r.title))
  const name = (title: string) => (start ? title.slice(start.length) : nameBeside(title, owner))
  const more = (fn === 'count' && behind.counted !== null ? behind.counted : behind.reached) - rows.length
  return (
    <details className="group mt-1">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-300 hover:text-ink-100 md:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 group-open:rotate-90" />
        {fold}
      </summary>
      <div className="pl-5">
        {about && <p className="text-[13px] text-ink-300">{about}</p>}
        <ul className="mt-1 divide-y divide-ink-700/70">
          {rows.map((r) => {
            const value = valueText(r, fn)
            const top = fn !== 'count' && r.value !== null && r.value === m.value
            return (
              <li key={`${r.blueprint}:${r.key}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 py-2 text-sm" title={r.title}>
                <Lamp level={r.level} />
                <div className="min-w-0">
                  <Link to={{ page: 'entity', blueprint: r.blueprint, key: r.key }} className={`${tap} text-ink-100 underline-offset-4 hover:underline`}>
                    <NameText name={name(r.title)} />
                  </Link>
                  {r.reasons.length > 0 && <p className="text-[13px] text-ink-300">{r.reasons.join('. ')}</p>}
                </div>
                <span className={`text-right tabular-nums ${top ? 'font-semibold text-ink-50' : 'text-ink-300'}`}>{value}</span>
              </li>
            )
          })}
        </ul>
        {more > 0 && <p className="text-[13px] text-ink-400">And {plain(more)} more.</p>}
      </div>
    </details>
  )
}

/** One place this entity copied from, and what else copied from there, drawn as a ring around it. */
function Taught({ bed, taught }: { bed: GroundItemResponse; taught: GroundItemResponse['taught'][number] }) {
  const blueprints = useBlueprints().data?.blueprints ?? []
  const { source, peers } = taught
  const unwanted = bed.fields.find((f) => f.role === 'unwanted')?.title
  if (!source) return <Panel className="p-4 text-sm text-ink-300">It copied from something you cannot see.</Panel>
  const mine = blueprints.find((b) => b.id === bed.blueprint)
  const others = peers.length === 0 ? 'Nothing else here copied from it.' : `${peers.length.toLocaleString('en-US')} ${peers.length === 1 ? 'other here' : 'others here'} copied from it.`
  return (
    <Panel className="p-4">
      <p className="text-sm text-ink-200">
        <Link to={{ page: 'entity', blueprint: source.blueprint, key: source.key }} className="font-medium text-ink-100 underline underline-offset-4">
          {source.title}
        </Link>{' '}
        taught it. {others}
      </p>
      {peers.length > 0 && (
        <div className="mt-3">
          <Orbit
            title={source.title}
            icon={<Icon name={source.icon ?? blueprints.find((b) => b.id === source.blueprint)?.icon} className="size-7" />}
            level={source.level}
            nodes={peers.map((p) => ({
              id: p.key,
              title: p.title,
              icon: <BlueprintIcon bp={mine} className="size-5" />,
              caption: `copied from ${source.title}${unwanted && p.unwanted !== null ? `, ${unwanted} ${plain(p.unwanted)}` : ''}`,
              direction: 'in' as const,
              level: p.level,
              onPick: () => navigate({ page: 'ground', blueprint: bed.blueprint, key: p.key }),
            }))}
          />
        </div>
      )}
    </Panel>
  )
}
