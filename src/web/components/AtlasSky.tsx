// The sky over the ground: the ground's front page, a star chart of the
// programs, and it means health. Each entity a map can be drawn of is a body
// round the sun, and its distance is its share of broken checks: the fewer,
// the nearer, in bands a reader can name, each band as wide as the bodies in
// it need. Its bearing is its own: the circle is cut in slices, one a sector
// where the map names one, and a body keeps its place in its slice whatever
// its health. Where the map names its primary holders, those few are drawn
// large and named, with the reader's own and the ones they pinned; every
// other is a small dot that names itself when asked, with a red glow where it
// is in a storm. Where it names none, every body is as big as what its map
// holds. The ring round a body is its checks, broken, without data, and
// holding. A body nothing could judge orbits furthest out, hollow; one that
// holds nothing or has no check is not drawn, and the panel counts them. A
// reader finds a program by typing, or keeps to their own. The kinds with a
// ground are not bodies: they are lenses across every program, listed in the
// panel. The page is part of the garden preview.

import { useMemo, useState, type ReactNode } from 'react'
import type { MapIndexHolder } from '../../shared/api.ts'
import type { CheckTally } from '../../shared/map.ts'
import { nearestOn, SKY_BANDS, skyBand, skyChart, skyNames, type Box, type SkyBand as Band } from '../atlas.ts'
import { useBlueprintName, useGroundIndex, useMapIndex } from '../api.ts'
import { counted, MAP_WORDS, percent, WORDS } from '../ground.ts'
import { navigate } from '../router.ts'
import { Alarm, Crumbs, FLOAT, ofText, PanelHead, PeekCard, Quiet, Ranked, Shell, SkyBand, textWidth, Tip, TipTitle, useSize, useTip, Verdict, type CoachStep, type KeyMark, type RankRow } from './Atlas.tsx'
import { Empty, ErrorNote, Link, useDesk } from './ui.tsx'
import { useVisit } from '../trail.ts'

const C = 500
const n = (v: number) => v.toLocaleString('en-US')
const px = (size: number, scale: number) => size / Math.max(0.2, scale)
const idOf = (h: MapIndexHolder) => `${h.blueprint}:${h.key}`
const tallyOf = (h: MapIndexHolder): CheckTally => ({ pass: h.checks - h.failing - h.unknown, fail: h.failing, unknown: h.unknown })
const shareOf = (h: MapIndexHolder) => (h.checks ? h.failing / h.checks : 0)

/** How big a holder is drawn at full size: by how much its map holds, on a gentle scale so the smallest still shows. */
const sizeOf = (h: MapIndexHolder) => 6 + 2.9 * Math.log2(1 + h.plots + h.members)
/** How big a minor body is drawn: a dot, whatever it holds. */
const MINOR = 5.5
/** How big the sun's glow is drawn, and how far the bands may reach: nearer the edge where no sector is named beyond them. */
const SUN = 56
const REACH = { plain: 490, sectors: 458 }

/** What each band is called on the chart, and the share of broken checks it stands for. */
const BAND_NAME: Record<Band, [string, string]> = {
  clear: ['Clear', 'none broken'],
  few: ['A few broken', 'under 20%'],
  many: ['Many broken', '20 to 50%'],
  storm: ['Storm', 'half or more'],
  unjudged: ['Not judged', 'no data'],
}

const STARS: [number, number, number, number][] = (() => {
  let x = 7
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647
  return Array.from({ length: 320 }, () => [rnd() * 2400 - 700, rnd() * 2400 - 700, 0.4 + rnd() * 1.1, 0.15 + rnd() * 0.35])
})()

/** The sky's first visit, in three steps. */
const SKY_TOUR: CoachStep[] = [
  { at: 'stage', title: 'Each body holds others', says: 'The nearer the sun, the fewer of its checks are broken. Its ring shows how many are broken, without data, and holding.' },
  { at: 'panel', title: 'Click one to peek', says: 'A click on a body, its name, or its row opens what it says here. A double click opens its planet.' },
  { at: 'over', title: 'Find one by name', says: 'Type to find one by name; Enter opens the first match. The ? beside the picture holds its key.' },
]

/** How many of the worst and of the largest carry their name without being asked. */
const NAMED = 4
/** How many found bodies are named at once; past that, the list names them. */
const FOUND_NAMED = 12

export function AtlasSky() {
  const grounds = useGroundIndex()
  const maps = useMapIndex()
  const name = useBlueprintName()
  const [tip, showTip, hideTip] = useTip()
  // The body a reader points at, on the chart or in the list: it is ringed and named.
  const [lit, setLit] = useState<string | null>(null)
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set())
  // The body a click opened: its peek leads the panel.
  const [peeked, setPeeked] = useState<string | null>(null)
  const [query, setQuery] = useVisit('sky.query', '')
  const [mine, setMine] = useVisit('sky.mine', false)
  const [ref, width, height] = useSize<HTMLDivElement>()
  const desk = useDesk()
  const w = MAP_WORDS
  const holders = useMemo(() => maps.data?.holders ?? [], [maps.data])
  // Where the estate names its primary holders, only they, the reader's own, and what the reader pinned are drawn at full size.
  const curated = useMemo(() => holders.some((h) => h.primary), [holders])
  // Every body that can be judged or was looked at and could not be: the rest hold nothing to say of.
  const drawn = useMemo(
    () =>
      holders.flatMap((h) => {
        const band = skyBand(h)
        if (!band) return []
        const big = !curated || h.primary === true || h.yours === true || pinned.has(idOf(h))
        return [{ h, band, big, r: big ? sizeOf(h) : MINOR }]
      }),
    [holders, curated, pinned],
  )
  const side = Math.min(width || 600, height || 600)
  const scale = side / 1000
  const small = scale < 0.5
  // The chart is a square round the sun; the picture is as wide or as tall as the stage, so the sky fills it.
  const aspect = width && height ? width / height : 1
  const view = aspect >= 1 ? { x: C - C * aspect, y: 0, w: 1000 * aspect, h: 1000 } : { x: 0, y: C - C / aspect, w: 1000, h: 1000 / aspect }
  const sectored = useMemo(() => drawn.some((d) => d.h.sector), [drawn])
  // A band's name says its share too where the chart is drawn large enough to spare the room; on a smaller chart the bodies' names need it more.
  const bandText = (band: Band) => (scale < 0.7 ? BAND_NAME[band][0] : `${BAND_NAME[band][0]} · ${BAND_NAME[band][1]}`)
  // Where everything sits: each band as wide as its bodies need, each body on its own bearing.
  const chart = useMemo(
    () =>
      skyChart(
        drawn.map((d) => ({ id: idOf(d.h), band: d.band, share: shareOf(d.h), r: d.r, sector: d.h.sector ?? null, key: d.h.key })),
        {
          c: C,
          radius: sectored ? REACH.sectors : REACH.plain,
          sun: SUN,
          nameWidth: Object.fromEntries(SKY_BANDS.map((band) => [band, textWidth(bandText(band), 12, 500) / Math.max(0.2, scale) + px(14, scale)])) as Record<Band, number>,
          nameHeight: px(20, scale),
        },
      ),
    // The layout follows the bodies and how big the names are drawn against them.
    [drawn, sectored, scale, small],
  )
  const at = chart.at
  // Each band's name on a plate across the top of its near edge: no body sits under one.
  const plates = SKY_BANDS.map((band) => {
    const text = bandText(band)
    const wide = textWidth(text, 12, 500) / Math.max(0.2, scale) + px(14, scale)
    const tall = px(20, scale)
    return { band, text, box: { x: C - wide / 2, y: C - chart.rings[band][0] - tall / 2, w: wide, h: tall } }
  })
  if (grounds.isLoading || maps.isLoading) return <div className="py-12 text-sm text-ink-400">Loading…</div>
  const kinds = Object.entries(grounds.data?.grounds ?? {})
    .map(([id, cover]) => ({ id, cover, title: name(id) }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const owned = maps.data?.owned === true
  const asked = query.trim().toLowerCase()
  const matches = (h: MapIndexHolder) => !asked || h.title.toLowerCase().includes(asked) || h.key.toLowerCase().includes(asked) || !!h.sector?.toLowerCase().includes(asked)
  // What the reader keeps to: their own when they ask for it. A body outside it leaves the chart and the list.
  const kept = drawn.filter((d) => !mine || d.h.yours)
  const ranked = [...kept].sort((a, b) => b.h.failing - a.h.failing || shareOf(b.h) - shareOf(a.h) || a.h.title.localeCompare(b.h.title))
  const found = asked ? ranked.filter((d) => matches(d.h)) : []
  const need = ranked.filter((d) => d.h.failing > 0)
  const furthest = [...need].sort((a, b) => shareOf(b.h) - shareOf(a.h) || b.h.failing - a.h.failing)[0]
  const largest = [...kept].sort((a, b) => b.r - a.r || a.h.title.localeCompare(b.h.title))
  const sizeAt = (d: (typeof drawn)[number]) => chart.r.get(idOf(d.h)) ?? d.r
  const undrawn = holders.length - drawn.length
  const every = kept.reduce((a, d) => ({ pass: a.pass + d.h.checks - d.h.failing - d.h.unknown, fail: a.fail + d.h.failing, unknown: a.unknown + d.h.unknown }), { pass: 0, fail: 0, unknown: 0 })
  const crosses = (p: Box, q: Box) => p.x < q.x + q.w + 2 && q.x < p.x + p.w + 2 && p.y < q.y + q.h + 2 && q.y < p.y + p.h + 2
  // Who stands named: the primaries the estate names, or the worst few and the largest few where it names none; then the pins and what is found. They are asked in that order, the largest first, so the few that must be named have first pick. A reader's own are drawn large and, like every other body, name themselves when pointed at, focused, or opened: those come last, so a name shown for a moment never moves one that stands.
  const standing = (curated ? kept.filter((d) => d.h.primary) : [...need.slice(0, NAMED), ...largest.slice(0, NAMED)]).sort((a, b) => b.r - a.r || a.h.title.localeCompare(b.h.title))
  const wanted = [...new Set([...(asked ? [] : standing.map((d) => idOf(d.h))), ...pinned, ...found.slice(0, FOUND_NAMED).map((d) => idOf(d.h)), ...(peeked ? [peeked] : []), ...(lit ? [lit] : [])])].flatMap((id) => kept.find((d) => idOf(d.h) === id) ?? [])
  const mustName = new Set(standing.map((d) => idOf(d.h)))
  const bodies: Box[] = kept.map((d) => {
    const [x, y] = at.get(idOf(d.h))!
    const pad = sizeAt(d) + px(4, scale)
    return { x: x - pad, y: y - pad, w: 2 * pad, h: 2 * pad }
  })
  const inView = (o: Box) => o.x >= view.x + 4 && o.y >= view.y + 4 && o.x + o.w <= view.x + view.w - 4 && o.y + o.h <= view.y + view.h - 4
  // The sun and the bright of its glow keep every name off them; the faint edge of the glow does not.
  const sun: Box = { x: C - chart.sun * 0.62, y: C - chart.sun * 0.62, w: chart.sun * 1.24, h: chart.sun * 1.24 }
  // A long name goes on two lines, broken at the space nearest its middle, so it finds room beside its body.
  const linesOf = (title: string): string[] => {
    const spaces = [...title.matchAll(/ /g)].map((m) => m.index)
    if (textWidth(title, 13, 500) <= 150 || !spaces.length) return [title]
    const cut = spaces.reduce((best, i) => (Math.abs(i - title.length / 2) < Math.abs(best - title.length / 2) ? i : best), spaces[0]!)
    return [title.slice(0, cut), title.slice(cut + 1)]
  }
  // A long name on three lines, its words shared out as evenly as they go, for where two lines are still too wide.
  const thirdsOf = (title: string): string[] => {
    const words = title.split(' ')
    if (words.length < 3 || textWidth(title, 13, 500) <= 190) return [title]
    let best: string[] = [title]
    let least = Infinity
    for (let i = 1; i < words.length - 1; i++)
      for (let j = i + 1; j < words.length; j++) {
        const lines = [words.slice(0, i).join(' '), words.slice(i, j).join(' '), words.slice(j).join(' ')]
        const widest = Math.max(...lines.map((l) => textWidth(l, 13, 500)))
        if (widest < least) [least, best] = [widest, lines]
      }
    return best
  }
  // The shapes a name may take: on two lines where it is long, which sits closer to its body, then on one, then on three.
  const shapesOf = (title: string) =>
    [...new Map([linesOf(title), [title], thirdsOf(title)].map((lines) => [lines.length, lines])).values()].map((lines) => ({ lines, w: Math.max(...lines.map((l) => textWidth(l, 13, 500))) / Math.max(0.2, scale) + px(10, scale), h: px(13, scale) * (0.3 + 1.2 * lines.length) }))
  // On a desk the search floats on the stage's upper left: it keeps every name out from under it.
  const floats: Box = { x: view.x, y: view.y, w: desk ? px(340, scale) : 0, h: desk ? px(64, scale) : 0 }
  // And the key in its lower left does the same.
  const keyBox: Box = { x: view.x, y: view.y + view.h - (desk ? px(52, scale) : 0), w: desk ? px(470, scale) : 0, h: desk ? px(52, scale) : 0 }
  // Each name at the first spot that is plainly its own body's: the far side from the sun first, touching; then off its body on a tie line. One with no clean spot is left out, and the hover card, the peek, and the ranked list still name it.
  const discs = kept.map((d) => ({ id: idOf(d.h), x: at.get(idOf(d.h))![0], y: at.get(idOf(d.h))![1], r: sizeAt(d) + px(2.5, scale), minor: !d.big }))
  const nameRoom = { c: [C, C] as [number, number], view: { x: view.x + 4, y: view.y + 4, w: view.w - 8, h: view.h - 8 }, touch: px(3, scale), clear: px(18, scale), clearMinor: px(7, scale) }
  // The names that must stand come before everything else on the chart that is only a word: they may step out as far as four times their body's size, and a sector's name gives way to them.
  const first = skyNames(
    wanted.filter((d) => mustName.has(idOf(d.h))).map((d) => ({ id: idOf(d.h), shapes: shapesOf(d.h.title), ties: [px(14, scale), ...[0.75, 1.25, 1.75, 2.25, 3, 4].map((k) => k * Math.max(sizeAt(d), px(14, scale)))] })),
    discs,
    { ...nameRoom, keepOut: [sun, floats, keyBox, ...plates.map((pl) => pl.box)] },
  )
  // Each sector's name beyond the bands, at the middle of its slice, where it fits on the picture and runs into no other.
  const sectorNames: { name: string; x: number; y: number; anchor: 'start' | 'middle' | 'end'; box: Box }[] = []
  // A chart drawn small, as on a phone, keeps its room for the bodies: the slices are still drawn, and the list says each sector.
  if (sectored && chart.sectors.length > 1 && !small)
    for (const sl of [...chart.sectors].sort((p, q) => q.count - p.count)) {
      const mid = (sl.from + sl.to) / 2
      const label = sl.name ?? 'Other'
      const wide = textWidth(label, 12, 500) / Math.max(0.2, scale)
      const tall = px(16, scale)
      const reach = REACH.sectors + px(8, scale) + tall / 2
      const [x, y] = [C + Math.cos(mid) * reach, C + Math.sin(mid) * reach]
      const anchor = Math.cos(mid) > 0.25 ? 'start' : Math.cos(mid) < -0.25 ? 'end' : 'middle'
      // Beyond the rim where the picture has the room; where it has not, slid in along the line until it is on the picture.
      const out = anchor === 'start' ? x : anchor === 'end' ? x - wide : x - wide / 2
      const box = { x: Math.min(view.x + view.w - 6 - wide, Math.max(view.x + 6, out)), y: y - tall / 2, w: wide, h: tall }
      // A slice too thin for its name at the rim goes unnamed, and so does a name that would lie on a body, a band's name, or another sector's: the ranked list and each peek say the sector.
      const roomy = (sl.to - sl.from) * REACH.sectors * scale >= 28
      if (roomy && inView(box) && !sectorNames.some((o) => crosses(o.box, box)) && ![...first.values()].some((nm) => crosses(nm.box, box)) && !bodies.some((bd) => crosses(bd, box)) && !plates.some((pl) => crosses(pl.box, box)) && !(desk && (crosses({ x: view.x, y: view.y, w: px(340, scale), h: px(64, scale) }, box) || crosses({ x: view.x, y: view.y + view.h - px(52, scale), w: px(470, scale), h: px(52, scale) }, box)))) sectorNames.push({ name: label, x: box.x, y, anchor: 'start', box })
    }
  // Then the pins, what is found, and what is pointed at or opened: a short step off at most, and clear of every name already standing.
  const rest = skyNames(
    wanted.filter((d) => !first.has(idOf(d.h))).map((d) => ({ id: idOf(d.h), shapes: shapesOf(d.h.title), ties: [px(14, scale)] })),
    discs,
    { ...nameRoom, keepOut: [sun, floats, keyBox, ...plates.map((pl) => pl.box), ...sectorNames.map((sn) => sn.box), ...[...first.values()].map((nm) => nm.box)] },
  )
  const spots = new Map([...first, ...rest])
  const names = new Map([...spots].map(([id, spot]) => [id, { ...spot, lines: shapesOf(kept.find((d) => idOf(d.h) === id)!.h.title)[spot.shape]!.lines }]))
  // The hover card reads the mark aloud with its reason: why it sits where it does, then what it holds.
  const holderTip = (h: MapIndexHolder, band: Band): ReactNode => (
    <>
      <TipTitle>{h.title}</TipTitle>
      {band === 'unjudged' ? `No check on it has data, so it sits in ${BAND_NAME[band][0]}.` : `${percent(shareOf(h))} broken (${n(h.failing)} of ${n(h.checks)}), so it sits in ${BAND_NAME[band][0]}.`}
      <span className="block text-ink-300">
        {[`Holds ${counted(h.plots, w.plot.toLowerCase())} and ${counted(h.members, 'thing')}`, h.primary ? 'primary' : '', h.sector ?? ''].filter(Boolean).join(' · ')}
      </span>
    </>
  )
  const open = (h: MapIndexHolder) => navigate({ page: 'map', blueprint: h.blueprint, key: h.key })
  const stage = (
    <div ref={ref} className="relative aspect-square w-full overflow-hidden rounded-2xl desk:absolute desk:inset-0 desk:aspect-auto desk:rounded-none" style={{ background: 'var(--color-atlas-space)' }}>
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="block size-full" role="group" onClick={(e) => !(e.target as Element).closest('[role=button]') && setPeeked(null)} aria-label={`The sky of ${w.planets}: ${counted(kept.length, w.planet.toLowerCase())}, each as far from the sun as its share of broken checks.`}>
        <defs>
          <radialGradient id="sky-sun">
            <stop offset="0" stopColor="var(--color-atlas-route)" />
            <stop offset="0.35" stopColor="var(--color-amber)" />
            <stop offset="1" stopColor="var(--color-amber)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sky-world" cx="38%" cy="35%">
            <stop offset="0" stopColor="var(--color-atlas-sea)" />
            <stop offset="1" stopColor="var(--color-atlas-sea-deep)" />
          </radialGradient>
        </defs>
        <g aria-hidden>
          {STARS.map(([x, y, r, o], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill="var(--color-ink-200)" opacity={o} />
          ))}
          {/* Each band's far edge as a faint ring: a body past it has crossed into the next band. */}
          {SKY_BANDS.map((band) => (
            <circle key={band} cx={C} cy={C} r={chart.rings[band][1]} fill="none" stroke="var(--color-orbit)" strokeOpacity={band === 'unjudged' ? 0.12 : 0.26} strokeDasharray={band === 'unjudged' ? '2 6' : undefined} />
          ))}
          {/* The slices, where the map names a sector: a faint line where one ends and the next begins, and each one's name beyond the bands. */}
          {sectored &&
            chart.sectors.length > 1 &&
            chart.sectors.map((sl) => <line key={sl.name ?? ''} x1={C + Math.cos(sl.from) * chart.sun} y1={C + Math.sin(sl.from) * chart.sun} x2={C + Math.cos(sl.from) * REACH.sectors} y2={C + Math.sin(sl.from) * REACH.sectors} stroke="var(--color-orbit)" strokeOpacity={0.34} strokeDasharray="2 5" />)}
          {sectorNames.map((sn) => (
            <text key={sn.name} x={sn.x} y={sn.y + px(4, scale)} textAnchor={sn.anchor} fontSize={px(12, scale)} fontWeight={500} fill="currentColor" className="text-ink-300">
              {sn.name}
            </text>
          ))}
          <circle cx={C} cy={C} r={chart.sun * 0.96} fill="url(#sky-sun)" opacity={0.55} />
          <circle cx={C} cy={C} r={chart.sun * 0.25} fill="var(--color-atlas-route)" />
          {plates.map((p) => (
            <g key={p.band}>
              <rect x={p.box.x} y={p.box.y} width={p.box.w} height={p.box.h} rx={p.box.h / 2} fill="var(--color-ink-950)" fillOpacity={0.85} stroke="var(--color-orbit)" strokeOpacity={0.3} strokeWidth={px(1, scale)} />
              <text x={C} y={p.box.y + p.box.h / 2 + px(4.2, scale)} textAnchor="middle" fontSize={px(12, scale)} fontWeight={500} fill="currentColor" className="text-ink-200">
                {p.text}
              </text>
            </g>
          ))}
        </g>
        {kept.map((d) => {
          const { h, band } = d
          const r = sizeAt(d)
          const id = idOf(h)
          const [x, y] = at.get(id)!
          const hit = !asked || matches(h)
          const on = lit === id || pinned.has(id) || peeked === id
          return (
            <g
              key={id}
              role="button"
              tabIndex={0}
              aria-pressed={peeked === id}
              aria-label={`${h.title}: ${BAND_NAME[band][0].toLowerCase()}, ${band === 'unjudged' ? 'every check without data' : ofText(tallyOf(h))}. ${counted(h.plots, w.plot.toLowerCase())} and ${counted(h.members, 'thing')}. Space opens a peek, Enter opens the ${w.planet.toLowerCase()}.`}
              className={`cursor-pointer outline-none focus-visible:[&>*:first-child]:stroke-orbit ${hit ? '' : 'opacity-25'}`}
              onClick={() => setPeeked(peeked === id ? null : id)}
              onDoubleClick={() => open(h)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') open(h)
                else if (e.key === ' ') {
                  e.preventDefault()
                  setPeeked(peeked === id ? null : id)
                }
              }}
              onPointerMove={(e) => {
                showTip(e, holderTip(h, band))
                if (lit !== id) setLit(id)
              }}
              onPointerLeave={() => {
                hideTip()
                setLit(null)
              }}
              onFocus={() => setLit(id)}
              onBlur={() => setLit(null)}
            >
              <circle cx={x} cy={y} r={Math.max(r + 6, px(23, scale))} fill="transparent" strokeWidth={px(2, scale)} />
              {(on || (asked && hit)) && <circle cx={x} cy={y} r={r + px(7, scale)} fill="none" stroke={on ? 'var(--color-ink-50)' : 'var(--color-atlas-route)'} strokeWidth={px(2, scale)} />}
              {band === 'unjudged' ? (
                <circle cx={x} cy={y} r={r} fill="var(--color-ink-950)" fillOpacity={0.6} stroke="var(--color-grey)" strokeWidth={px(2, scale)} strokeDasharray={`${px(4, scale)} ${px(3, scale)}`} />
              ) : d.big ? (
                <>
                  <circle cx={x} cy={y} r={r} fill="url(#sky-world)" />
                  <CheckRing x={x} y={y} r={r + px(2.5, scale)} t={tallyOf(h)} width={px(3.5, scale)} />
                </>
              ) : (
                <>
                  {/* A minor body is a quiet dot in its checks' colours; one in a storm keeps a red glow, so it is not missed. */}
                  {band === 'storm' && <circle cx={x} cy={y} r={r * 2.6} fill="var(--color-red)" opacity={0.22} />}
                  <circle cx={x} cy={y} r={r * 0.55} fill="url(#sky-world)" />
                  <CheckRing x={x} y={y} r={r * 0.8} t={tallyOf(h)} width={Math.max(r * 0.45, px(1.6, scale))} />
                </>
              )}
            </g>
          )
        })}
        {/* The names last, over every body, each on its plate. One that stands off its body is tied to it by a short line. A plate is part of its body's target: pointing at it rings the body, and a click peeks it. The body itself is the one tab stop. */}
        <g aria-hidden>
          {kept.map((d) => {
            const name = names.get(idOf(d.h))
            if (!name?.tied) return null
            const [x, y] = at.get(idOf(d.h))!
            const [ex, ey] = nearestOn(name.box, [x, y])
            const far = Math.hypot(ex - x, ey - y) || 1
            return <line key={idOf(d.h)} pointerEvents="none" x1={x + ((ex - x) / far) * (sizeAt(d) + px(3, scale))} y1={y + ((ey - y) / far) * (sizeAt(d) + px(3, scale))} x2={ex} y2={ey} stroke={lit === idOf(d.h) ? 'var(--color-ink-50)' : 'var(--color-ink-200)'} strokeOpacity={0.85} strokeWidth={px(1.2, scale)} />
          })}
          {kept.map((d) => {
            const id = idOf(d.h)
            const name = names.get(id)
            if (!name) return null
            const box = name.box
            const on = lit === id || peeked === id
            return (
              <g
                key={id}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  setPeeked(peeked === id ? null : id)
                }}
                onDoubleClick={() => open(d.h)}
                onPointerMove={() => lit !== id && setLit(id)}
                onPointerLeave={() => setLit(null)}
              >
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={px(5, scale)} fill="var(--color-ink-950)" fillOpacity={on ? 0.96 : 0.86} stroke={on ? 'var(--color-ink-50)' : 'none'} strokeWidth={px(1.2, scale)} />
                <text x={box.x + box.w / 2} y={box.y + px(13.5, scale)} textAnchor="middle" fontSize={px(13, scale)} fontWeight={d.h.primary || !curated ? 500 : 400} fill="currentColor" className={on || d.h.primary || !curated ? 'text-ink-50' : 'text-ink-200'}>
                  {name.lines.map((line, k) => (
                    <tspan key={k} x={box.x + box.w / 2} dy={k ? px(15.6, scale) : 0}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
  const over = holders.length > 0 && (
    <form
      role="search"
      className={`flex max-w-[19rem] flex-wrap items-center gap-2 px-2 py-1.5 ${FLOAT}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (found[0]) open(found[0].h)
      }}
    >
      <label className="flex items-center gap-2 text-[13px] text-ink-300">
        <span className="sr-only">Find a {w.planet.toLowerCase()} by its name or key</span>
        <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden className="shrink-0">
          <circle cx={11} cy={11} r={7} fill="none" stroke="currentColor" strokeWidth={2} />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        </svg>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Find a ${w.planet.toLowerCase()}`} className="h-11 w-44 rounded-md border border-edge bg-ink-950 px-2.5 text-[14px] text-ink-50 placeholder:text-ink-500 md:h-8" />
      </label>
      {asked && (
        <span aria-live="polite" className="order-last basis-full px-1 text-[13px] text-ink-300">
          {found.length ? `${n(found.length)} found. Enter opens ${found[0]!.h.title}.` : 'None found.'}
        </span>
      )}
      {owned && (
        <button type="button" aria-pressed={mine} onClick={() => setMine(!mine)} className={`min-h-11 rounded-full border px-3 text-[13px] md:min-h-8 ${mine ? 'border-orbit bg-orbit/15 text-ink-50' : 'border-ink-700 text-ink-200 hover:border-ink-500'}`}>
          Mine
        </button>
      )}
    </form>
  )
  const opened = kept.find((d) => idOf(d.h) === peeked)
  const peek = opened && (
    <PeekCard
      kicker={[opened.h.primary ? `Primary ${w.planet.toLowerCase()}` : w.planet, BAND_NAME[opened.band][0], opened.h.sector ?? ''].filter(Boolean).join(' · ')}
      title={opened.h.title}
      level={opened.h.level}
      entity={{ blueprint: opened.h.blueprint, key: opened.h.key }}
      open={{ to: { page: 'map', blueprint: opened.h.blueprint, key: opened.h.key }, label: `Open the ${w.planet.toLowerCase()}` }}
      tick={{ on: pinned.has(peeked!), set: (on) => setPinned(new Set(on ? [...pinned, peeked!] : [...pinned].filter((x) => x !== peeked))), label: curated ? 'Keep it large and named on the chart' : 'Keep it named on the chart' }}
      onClose={() => setPeeked(null)}
    >
      <ul className="mt-2.5 space-y-1 text-[13px] leading-snug text-ink-300">
        <li>
          {opened.band === 'unjudged' ? (
            <>Every one of its {n(opened.h.checks)} checks is without data, so it is not judged.</>
          ) : (
            <>
              <b className={`font-medium ${opened.h.failing ? 'text-red' : 'text-ink-100'}`}>{n(opened.h.failing)} broken</b> of {n(opened.h.checks)} checks ({percent(shareOf(opened.h))}), {n(opened.h.unknown)} with no data, {n(opened.h.checks - opened.h.failing - opened.h.unknown)} holding.
            </>
          )}
        </li>
        <li>
          Its map holds {counted(opened.h.plots, w.plot.toLowerCase())} and {counted(opened.h.members, 'thing')}.
        </li>
        {opened.h.yours && <li>It is yours.</li>}
      </ul>
    </PeekCard>
  )
  const budgeted = kinds.filter((k) => k.cover.share !== null)
  const unbudgeted = kinds.filter((k) => k.cover.share === null)
  const shown = asked ? found : ranked
  const pin = (id: string, title: string) => {
    const on = pinned.has(id)
    return (
      <button type="button" aria-pressed={on} aria-label={`Keep ${title} ${curated ? 'large and ' : ''}named on the chart`} title={curated ? 'Keep it large and named' : 'Keep it named'} onClick={() => setPinned(new Set(on ? [...pinned].filter((x) => x !== id) : [...pinned, id]))} className={`inline-grid size-11 shrink-0 place-items-center rounded-lg md:size-9 ${on ? 'text-ink-50' : 'text-ink-500 hover:text-ink-200'}`}>
        <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 21v-7M8 3h8l-1 6 3 3v2H6v-2l3-3z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </button>
    )
  }
  const rows: RankRow[] = shown.map((d) => {
    const id = idOf(d.h)
    return {
      id,
      title: d.h.title,
      says: [d.band === 'unjudged' ? 'not judged' : `${n(d.h.failing)} broken of ${n(d.h.checks)}`, d.h.sector ?? '', d.h.yours ? 'yours' : ''].filter(Boolean).join(' · '),
      broken: d.h.failing,
      picked: peeked === id,
      onPick: () => setPeeked(peeked === id ? null : id),
      onPoint: (on) => setLit(on ? id : null),
      mark: curated ? (
        <svg width={10} height={10} viewBox="0 0 10 10" role="img" aria-label={d.h.primary ? 'Primary' : 'Other'}>
          {d.h.primary ? <circle cx={5} cy={5} r={4.5} fill="var(--color-ink-100)" /> : <circle cx={5} cy={5} r={2} fill="var(--color-ink-500)" />}
        </svg>
      ) : undefined,
      after: pin(id, d.h.title),
    }
  })
  const panel = (
    <>
      <Verdict kicker={WORDS.sky}>
        {kept.length ? (
          need.length ? (
            <>
              <Alarm>{n(need.length)}</Alarm> of {counted(kept.length, w.planet.toLowerCase(), w.planets)} {need.length === 1 ? 'has' : 'have'} broken checks.
            </>
          ) : (
            <>
              {counted(kept.length, w.planet.toLowerCase(), w.planets)}, <Quiet>none with a broken check.</Quiet>
            </>
          )
        ) : mine && drawn.length ? (
          <>None of the {w.planets} on the chart is yours.</>
        ) : holders.length ? (
          <>
            {counted(holders.length, w.planet.toLowerCase(), w.planets)}, <Quiet>none with anything checked yet.</Quiet>
          </>
        ) : (
          'Nothing grows here yet.'
        )}
      </Verdict>
      {kept.length > 0 && <SkyBand t={every} words={{ broken: 'broken', nodata: 'no data', holding: 'holding' }} className="mt-5" />}
      <ErrorNote error={grounds.error ?? maps.error} />
      {!kinds.length && !holders.length && !grounds.error && (
        <div className="mt-6">
          <Empty>
            No blueprint has a ground or a map yet. Give one a ground on its Ground tab in{' '}
            <Link to={{ page: 'model', id: null }} className="text-ink-100 underline underline-offset-4">
              the model
            </Link>
            , or a budget on one of its number fields.
          </Empty>
        </div>
      )}
      {rows.length > 0 && (
        <section>
          <PanelHead title={asked ? `Found ${n(rows.length)}` : 'Most broken'} />
          <Ranked label={asked ? 'Found' : 'Most broken first'} rows={rows} />
        </section>
      )}
      {(furthest || undrawn > 0) && (
        <p className="mt-4 text-[13px] leading-snug text-ink-300">
          {furthest && (
            <>
              Furthest out: {furthest.h.title}, {percent(shareOf(furthest.h))} broken.{' '}
            </>
          )}
          {undrawn > 0 && `${counted(undrawn, w.planet.toLowerCase(), w.planets)} ${undrawn === 1 ? 'holds' : 'hold'} nothing checked.`}
        </p>
      )}
      {kinds.length > 0 && (
        <section>
          <PanelHead title="By kind" />
          <Ranked
            label="Each kind against its budgets"
            rows={budgeted.map((k) => ({ id: k.id, title: k.title, says: `${n(k.cover.measured - k.cover.inside)} outside of ${n(k.cover.measured)}`, broken: k.cover.measured - k.cover.inside, to: { page: 'ground', blueprint: k.id } }))}
          />
          {unbudgeted.length > 0 && (
            <p className="mt-2 px-2 text-[13px] leading-snug text-ink-300">
              {unbudgeted.map((k, i) => (
                <span key={k.id}>
                  {i > 0 && (i === unbudgeted.length - 1 ? ' and ' : ', ')}
                  <Link to={{ page: 'model', id: k.id }} className="inline-flex min-h-11 items-center text-ink-200 underline underline-offset-4 md:min-h-0">
                    {k.title}
                  </Link>
                </span>
              ))}{' '}
              {unbudgeted.length === 1 ? 'has' : 'have'} no budgets.
            </p>
          )}
        </section>
      )}
    </>
  )
  // The key, in the chart's own marks.
  const ring = (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      <CheckRing x={8} y={8} r={6} t={{ fail: 3, unknown: 2, pass: 5 }} width={2.5} />
    </svg>
  )
  const disc = (r: number) => (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      <circle cx={8} cy={8} r={r} fill="var(--color-atlas-sea)" stroke="var(--color-signal-green)" strokeWidth={1.5} />
    </svg>
  )
  const legend: KeyMark[] = [
    ...(curated
      ? [
          { mark: disc(6.5), word: 'primary', says: `Large: a primary ${w.planet.toLowerCase()}, one of yours, or one you pinned, as big as what its map holds.` },
          { mark: disc(2.5), word: 'other', says: `Small: every other ${w.planet.toLowerCase()}. A red glow marks one in a storm. It names itself when you point at it.` },
        ]
      : [{ mark: disc(5), word: 'size: what it holds', says: `Each body is a ${w.planet.toLowerCase()}, as big as what its map holds.` }]),
    { mark: ring, word: 'broken · no data · holding', says: 'The ring is its checks: red broken, grey with no data, green holding.' },
    { mark: <i aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: 'var(--color-atlas-route)' }} />, word: 'nearer: fewer broken', says: 'Distance is health: the smaller its share of broken checks, the nearer the sun. Its bearing is its sector and never moves.' },
  ]
  return (
    <>
      <Shell crumbs={<Crumbs steps={[{ label: w.sky }]} />} stage={stage} over={over || undefined} panel={panel} peek={peek || undefined} legend={drawn.length ? legend : undefined} tour={drawn.length ? { id: 'sky', steps: SKY_TOUR } : undefined} />
      <Tip tip={tip} />
    </>
  )
}

/** A ring round a body split as its checks are: broken, then no data, then holding. */
function CheckRing({ x, y, r, t, width }: { x: number; y: number; r: number; t: CheckTally; width: number }) {
  const all = t.pass + t.fail + t.unknown
  if (!all) return <circle cx={x} cy={y} r={r} fill="none" stroke="var(--color-ink-600)" strokeWidth={width} strokeDasharray={`${width} ${width}`} />
  const c = 2 * Math.PI * r
  const seg = (v: number, from: number, colour: string) => (v ? <circle cx={x} cy={y} r={r} fill="none" stroke={colour} strokeWidth={width} strokeDasharray={`${(v / all) * c} ${c}`} strokeDashoffset={-from * c} transform={`rotate(-90 ${x} ${y})`} /> : null)
  return (
    <>
      {seg(t.fail, 0, 'var(--color-signal-red)')}
      {seg(t.unknown, t.fail / all, 'var(--color-grey)')}
      {seg(t.pass, (t.fail + t.unknown) / all, 'var(--color-signal-green)')}
    </>
  )
}
