import { describe, expect, it } from 'vitest'
import type { MapMember, MapPlot, MapView } from '../shared/map.ts'
import { flowerOf, archipelagoOf, breakable, lineHits, nearestOn, routeOrder, fanOut, folderOf, grow, hexCenter, hexKey, placeLabels, planetOf, clusterHexes, DIRS, nowhereOf, benchOf, skyBand, skyChart, skyNames, SKY_BANDS, type SkyBody, type SkyDisc, type SkyNameRoom, type SkyRoom } from './atlas.ts'

const thing = { icon: null, reasons: [], part: 'comet', failing: 0, unknown: 0, actions: [], links: [] }
const plot = (key: string, at: string[], checks: MapPlot['checks'] = []): MapPlot => ({ ...thing, blueprint: 'service', key, title: key, level: 'green', checks, at: at.map((place) => ({ place, blueprint: 'running', key: `${key}@${place}`, title: key, level: 'green' })) })
const member = (key: string, place: string | null, plotKey: string | null, checks: MapMember['checks'] = []): MapMember => ({ ...thing, blueprint: 'database', key, title: key, level: 'green', checks, place, plot: plotKey })
const check = (state: 'pass' | 'fail' | 'unknown', title = 'Has tests') => ({ kind: 'guard' as const, id: 't', title, of: null, state, ladder: 'guard:t', rung: 0 })

const map: MapView = {
  ladders: [],
  holder: { blueprint: 'program', key: 'comet', title: 'CM', icon: null, level: 'green' },
  parts: [],
  places: ['Prod', 'Test'].map((key) => ({ key, title: key, icon: null, plots: 0, members: 0, open: 0, failing: 0, unknown: 0, level: 'green' as const })),
  plots: [plot('api', ['Prod', 'Test']), plot('web', ['Prod']), plot('lib', [])],
  members: [member('db1', 'Prod', null), member('db2', 'Prod', 'api'), member('db3', 'Test', null), member('db4', null, null)],
  counts: { plots: 3, placed: 2, members: 4, open: 3, checks: 0, failing: 0, unknown: 0 },
  truncated: [],
}

describe('the planet', () => {
  const planet = planetOf(map)

  it('gives each place one cell for each garden that runs on it and one for each kind of thing on its open ground, however many things that is', () => {
    expect(planet.lands.map((l) => [l.place.key, l.cells.filter((c) => c.patch).length, l.cells.filter((c) => c.open).length])).toEqual([
      ['Prod', 2, 1],
      ['Test', 1, 1],
    ])
    const crowded: MapView = { ...map, members: [...map.members, ...Array.from({ length: 30 }, (_, i) => member(`extra${i}`, 'Prod', null))] }
    expect(planetOf(crowded).lands.find((l) => l.place.key === 'Prod')!.cells).toHaveLength(3)
  })

  it("paints a garden's cell by what it runs there, never by the service's own checks or another place's", () => {
    const api = planet.cells.find((c) => c.patch?.plot.key === 'api' && planet.lands[c.land]!.place.key === 'Prod')!
    expect(api.here.map((t) => t.key)).toEqual(['db2'])
    const open = planet.cells.find((c) => c.open && planet.lands[c.land]!.place.key === 'Prod')!
    expect([open.open!.blueprint, open.here.map((t) => t.key)]).toEqual(['database', ['db1']])
  })

  it("lays each part's gardens on a land together as one cluster", () => {
    const parts = ['comet', 'north', 'south', 'east']
    const sizes = [30, 9, 4, 2]
    const plots = sizes.flatMap((size, k) => Array.from({ length: size }, (_, i) => ({ ...plot(`${parts[k]}-${i}`, ['Prod']), part: parts[k]! })))
    const parted: MapView = { ...map, parts: parts.slice(1).map((key) => ({ blueprint: 'program', key, title: key, icon: null, level: 'green' as const })), plots, members: [{ ...member('alone', 'Prod', null), part: 'south' }] }
    const cells = planetOf(parted).cells
    for (const part of parts) {
      const mine = cells.filter((c) => c.patch?.plot.part === part)
      expect(mine).toHaveLength(sizes[parts.indexOf(part)]!)
      // Every cell of the part is reached from its first, stepping only over the part's own cells.
      const keys = new Set(mine.map((c) => hexKey(c.q, c.r)))
      const seen = new Set([hexKey(mine[0]!.q, mine[0]!.r)])
      const walk = [mine[0]!]
      for (const c of walk)
        for (const [dq, dr] of DIRS) {
          const k = hexKey(c.q + dq, c.r + dr)
          if (keys.has(k) && !seen.has(k)) {
            seen.add(k)
            walk.push(mine.find((m) => hexKey(m.q, m.r) === k)!)
          }
        }
      expect(seen.size).toBe(mine.length)
    }
    // Open ground lies in the region of the part most of it is of.
    const alone = cells.find((c) => c.open)!
    expect(alone.part).toBe('south')
    expect(DIRS.some(([dq, dr]) => cells.some((c) => c.patch?.plot.part === 'south' && c.q === alone.q + dq && c.r === alone.r + dr))).toBe(true)
    expect(new Set(cells.map((c) => hexKey(c.q, c.r))).size).toBe(cells.length)
  })

  it('shares hexes so that every one is taken once', () => {
    const hexes = Array.from({ length: 5 }, (_, q) => Array.from({ length: 4 }, (_, r): [number, number] => [q, r])).flat()
    const shared = clusterHexes(hexes, [12, 0, 5, 3])
    expect(shared.map((g) => g.length)).toEqual([12, 0, 5, 3])
    expect(new Set(shared.flat().map((h) => hexKey(h[0], h[1]))).size).toBe(20)
  })

  it('keeps every cell on the globe', () => {
    for (const c of planet.cells) expect(Math.hypot(c.x - 500, c.y - 500)).toBeLessThan(372)
  })

  it('ties to no place the things on none and every plot, for its own checks', () => {
    const nowhere = nowhereOf(map)
    expect([nowhere.plots.map((p) => p.key), nowhere.members.map((m) => m.key)]).toEqual([['api', 'web', 'lib'], ['db4']])
  })
})

describe('the workshop bench', () => {
  const some: MapView = { ...map, plots: [plot('lib', []), plot('api', ['Prod'])], members: [member('db4', null, null), ...['r1', 'r2', 'r3'].map((k) => ({ ...member(k, null, null), blueprint: 'repository' })), member('db1', 'Prod', null)] }

  it('lays one cell for each kind of thing on no place, the biggest kind first, then one for each plot, and none for what is on a place', () => {
    const bench = benchOf(some, 100, 60)
    expect(bench.cells.map((c) => (c.open ? `${c.open.blueprint}:${c.open.members.length}` : `plot:${c.plot!.key}`))).toEqual(['repository:3', 'database:1', 'plot:lib', 'plot:api'])
  })

  it('keeps every cell on the bench, shrinking them until they fit, and no two on one spot', () => {
    const many: MapView = { ...map, members: [], plots: Array.from({ length: 345 }, (_, i) => plot(`s${i}`, [])) }
    const bench = benchOf(many, 190, 110)
    expect(bench.cells).toHaveLength(345)
    expect(bench.h).toBeLessThanOrEqual(110)
    for (const c of bench.cells) expect(c.x + c.s).toBeLessThanOrEqual(190 + 1e-9)
    expect(new Set(bench.cells.map((c) => `${c.x},${c.y}`)).size).toBe(345)
  })

  it('is nothing where there is no plot and everything is on a place', () => {
    expect(benchOf({ plots: [], members: [member('db1', 'Prod', null)] }, 190, 110)).toEqual({ cells: [], h: 0 })
  })
})

describe('the sky of programs', () => {
  const h = (checks: number, failing: number, unknown = 0, plots = 1, members = 1) => ({ plots, members, checks, failing, unknown })

  it('puts a holder in the band its share of broken checks names', () => {
    expect(skyBand(h(10, 0))).toBe('clear')
    expect(skyBand(h(10, 0, 4))).toBe('clear')
    expect(skyBand(h(100, 19))).toBe('few')
    expect(skyBand(h(100, 20))).toBe('many')
    expect(skyBand(h(100, 49))).toBe('many')
    expect(skyBand(h(100, 50))).toBe('storm')
  })

  it('sets one whose every check is without data apart, never among the clear', () => {
    expect(skyBand(h(8, 0, 8))).toBe('unjudged')
  })

  it('draws nothing for a holder that holds nothing or has no check', () => {
    expect(skyBand(h(0, 0))).toBeNull()
    expect(skyBand(h(5, 1, 0, 0, 0))).toBeNull()
  })
})

describe('the chart of the sky', () => {
  const room: SkyRoom = { c: 500, radius: 490, sun: 56, nameWidth: { clear: 150, few: 190, many: 200, storm: 170, unjudged: 150 }, nameHeight: 26 }
  const bandOf = (share: number): SkyBody['band'] => (share === 0 ? 'clear' : share < 0.2 ? 'few' : share < 0.5 ? 'many' : 'storm')
  const body = (i: number, share: number, over: Partial<SkyBody> = {}): SkyBody => ({ id: `p${i}`, key: `k${String(i).padStart(3, '0')}`, share, band: bandOf(share), r: i % 12 === 0 ? 26 : 5.5, sector: null, ...over })
  const dist = (chart: ReturnType<typeof skyChart>, id: string) => Math.hypot(chart.at.get(id)![0] - 500, chart.at.get(id)![1] - 500)
  const bearing = (chart: ReturnType<typeof skyChart>, id: string) => Math.atan2(chart.at.get(id)![1] - 500, chart.at.get(id)![0] - 500)

  /** What must hold of any chart: no two bodies touch, each is inside its band, the bands follow one another out from the sun and fit the chart, and in a band the fewer broken are never further out. */
  const sound = (bodies: SkyBody[]) => {
    const chart = skyChart(bodies, room)
    for (const a of bodies)
      for (const b of bodies) {
        if (a.id >= b.id) continue
        const [p, q] = [chart.at.get(a.id)!, chart.at.get(b.id)!]
        expect(Math.hypot(p[0] - q[0], p[1] - q[1]), `${a.id} and ${b.id} touch`).toBeGreaterThan(chart.r.get(a.id)! + chart.r.get(b.id)!)
        if (a.band === b.band && a.share < b.share) expect(dist(chart, a.id), `${a.id} is less broken than ${b.id} and further out`).toBeLessThanOrEqual(dist(chart, b.id) + 1e-6)
      }
    for (const b of bodies) {
      expect(dist(chart, b.id) - chart.r.get(b.id)!).toBeGreaterThanOrEqual(chart.rings[b.band][0] - 1e-6)
      expect(dist(chart, b.id) + chart.r.get(b.id)!).toBeLessThanOrEqual(chart.rings[b.band][1] + 1e-6)
    }
    SKY_BANDS.forEach((band, i) => {
      expect(chart.rings[band][1]).toBeGreaterThan(chart.rings[band][0])
      if (i) expect(chart.rings[band][0]).toBeCloseTo(chart.rings[SKY_BANDS[i - 1]!]![1], 6)
    })
    expect(chart.rings.unjudged[1]).toBeLessThanOrEqual(room.radius + 1e-6)
    return chart
  }
  const width = (chart: ReturnType<typeof skyChart>, band: SkyBody['band']) => chart.rings[band][1] - chart.rings[band][0]

  it('gives one crowded band the room, as a gradient by share, and keeps the empty bands thin', () => {
    const chart = sound(Array.from({ length: 60 }, (_, i) => body(i, 0.2 + (i * 37 % 60) / 200)))
    expect(width(chart, 'many')).toBeGreaterThan(250)
    for (const band of ['clear', 'few', 'storm', 'unjudged'] as const) expect(width(chart, band)).toBeLessThan(40)
    // Not a pile on one circle: the band's bodies stand at many depths.
    expect(new Set(Array.from({ length: 60 }, (_, i) => Math.round(dist(chart, `p${i}`)))).size).toBeGreaterThan(8)
  })

  it('keeps sixty that are all clear off the sun and off each other, in a few whole levels', () => {
    const chart = sound(Array.from({ length: 60 }, (_, i) => body(i, 0)))
    for (let i = 0; i < 60; i++) expect(dist(chart, `p${i}`) - chart.r.get(`p${i}`)!).toBeGreaterThanOrEqual(chart.sun - 1e-6)
    expect(width(chart, 'clear')).toBeGreaterThan(250)
    // Equal shares fill levels together: far fewer levels than bodies.
    expect(new Set(Array.from({ length: 60 }, (_, i) => Math.round(dist(chart, `p${i}`)))).size).toBeLessThan(16)
  })

  it('shares the room between the bands by how many each holds when they are spread evenly', () => {
    const chart = sound(Array.from({ length: 60 }, (_, i) => body(i, [0, 0.1, 0.3, 0.7][i % 4]! + (i % 4 ? (i % 7) / 100 : 0))))
    for (const band of ['clear', 'few', 'many', 'storm'] as const) expect(width(chart, band)).toBeGreaterThan(70)
    expect(width(chart, 'unjudged')).toBeLessThan(40)
  })

  it('draws a chart that needs more room than there is smaller, bodies and all, and still sound', () => {
    const chart = sound(Array.from({ length: 60 }, (_, i) => body(i, 0.2 + i / 250, { r: 30 })))
    expect(chart.r.get('p0')!).toBeLessThan(30)
    expect(chart.sun).toBeLessThan(room.sun)
  })

  it('gives each sector a slice as wide as its share of the bodies, in alphabetical order with the unnamed last', () => {
    const bodies = [...Array.from({ length: 6 }, (_, i) => body(i, 0.3, { sector: 'zeta' })), ...Array.from({ length: 3 }, (_, i) => body(10 + i, 0.3, { sector: 'alpha' })), ...Array.from({ length: 3 }, (_, i) => body(20 + i, 0.3, { sector: null }))]
    const chart = sound(bodies)
    expect(chart.sectors.map((sl) => [sl.name, sl.count])).toEqual([
      ['alpha', 3],
      ['zeta', 6],
      [null, 3],
    ])
    expect(chart.sectors[0]!.from).toBeCloseTo(-Math.PI / 2, 6)
    expect(chart.sectors.map((sl) => (sl.to - sl.from) / (2 * Math.PI))).toEqual([0.25, 0.5, 0.25].map((v) => expect.closeTo(v, 6)))
    // Every body lies inside its own slice.
    for (const b of bodies) {
      const sl = chart.sectors.find((x) => x.name === b.sector)!
      const a = (((bearing(chart, b.id) + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      expect(a).toBeGreaterThan(sl.from + Math.PI / 2)
      expect(a).toBeLessThan(sl.to + Math.PI / 2)
    }
  })

  it('keeps a body on its bearing when its health moves: only its distance changes', () => {
    const bodies = Array.from({ length: 30 }, (_, i) => body(i, 0.25 + (i % 5) / 30, { sector: i % 3 ? 'a' : 'b' }))
    const before = skyChart(bodies, room)
    const after = skyChart(
      bodies.map((b) => (b.id === 'p7' ? { ...b, share: 0, band: 'clear' as const } : b.id === 'p8' ? { ...b, share: 0.9, band: 'storm' as const } : b)),
      room,
    )
    for (const b of bodies) expect(bearing(after, b.id)).toBeCloseTo(bearing(before, b.id), 6)
    expect(dist(after, 'p7')).toBeLessThan(dist(before, 'p7'))
    expect(dist(after, 'p8')).toBeGreaterThan(dist(before, 'p8'))
  })

  it('lands the same each time, and draws nothing but the bands for no bodies', () => {
    const bodies = Array.from({ length: 25 }, (_, i) => body(i, (i % 10) / 10))
    expect([...skyChart(bodies, room).at]).toEqual([...skyChart([...bodies].reverse(), room).at].reverse())
    const empty = skyChart([], room)
    expect(empty.at.size).toBe(0)
    expect(empty.rings.unjudged[1]).toBeLessThanOrEqual(room.radius)
  })
})

describe('the names on the sky', () => {
  const room: SkyNameRoom = { c: [500, 500], view: { x: 0, y: 0, w: 1000, h: 1000 }, keepOut: [{ x: 440, y: 440, w: 120, h: 120 }], touch: 4, clear: 18, clearMinor: 8 }
  const gap = (box: { x: number; y: number; w: number; h: number }, d: SkyDisc) => Math.hypot(Math.min(box.x + box.w, Math.max(box.x, d.x)) - d.x, Math.min(box.y + box.h, Math.max(box.y, d.y)) - d.y) - d.r
  const ask = (id: string, ties: number[] = [20]) => ({ id, shapes: [{ w: 150, h: 20 }], ties })

  it('puts a name on the far side of its body from the sun, touching it, when that spot is clean', () => {
    const body: SkyDisc = { id: 'a', x: 800, y: 500, r: 25 }
    const spot = skyNames([ask('a')], [body], room).get('a')!
    expect(spot.tied).toBe(false)
    expect(spot.box.x).toBeCloseTo(800 + 25 + 4, 6)
    expect(spot.box.y + spot.box.h / 2).toBeCloseTo(500, 6)
  })

  it('never leaves a name nearer another body than its own: a body right above the spot refuses it', () => {
    // The live mistake: the name's own body is to its right, and another large body sits right above where the name would go.
    const own: SkyDisc = { id: 'ops', x: 420, y: 300, r: 26 }
    const above: SkyDisc = { id: 'guide', x: 320, y: 255, r: 30 }
    // The far side from the sun (up and to the left) and the left side both run under the other body.
    const spot = skyNames([ask('ops')], [own, above], room).get('ops')!
    expect(gap(spot.box, above)).toBeGreaterThanOrEqual(room.clear)
    expect(gap(spot.box, above)).toBeGreaterThan(Math.max(0, gap(spot.box, own)))
    // It is not left of its own body, under the other one.
    expect(spot.box.x + spot.box.w).toBeGreaterThan(own.x - own.r)
  })

  it('holds for every name on a crowded chart: each is plainly its own body\'s, and none lies on a body, a kept box, or another name', () => {
    let seed = 11
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const discs: SkyDisc[] = Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, x: 80 + rnd() * 840, y: 80 + rnd() * 840, r: i % 9 === 0 ? 26 : 6, minor: i % 9 !== 0 }))
    const got = skyNames(discs.map((d) => ask(d.id)), discs, room)
    expect(got.size).toBeGreaterThan(5)
    const boxes = [...got]
    for (const [id, spot] of boxes) {
      const own = discs.find((d) => d.id === id)!
      const mine = Math.max(0, gap(spot.box, own))
      // Touching, its own body is nearer by half; tied, no large body is as near, and every dot is well clear.
      for (const d of discs) if (d.id !== id) expect(gap(spot.box, d), `${id}'s name is too near ${d.id}`).toBeGreaterThanOrEqual((spot.tied ? (d.minor ? room.clearMinor * 0.6 : mine + room.clear) : Math.max(d.minor ? room.clearMinor : room.clear, 2 * mine)) - 1e-6)
      // Touching, it stands a hair off its body; tied, a short step: never further.
      expect(mine).toBeLessThanOrEqual((spot.tied ? 20 : room.touch) + 1e-6)
      const k = room.keepOut[0]!
      expect(spot.box.x < k.x + k.w && k.x < spot.box.x + spot.box.w && spot.box.y < k.y + k.h && k.y < spot.box.y + spot.box.h).toBe(false)
      for (const [other, o] of boxes) if (other !== id) expect(spot.box.x < o.box.x + o.box.w && o.box.x < spot.box.x + spot.box.w && spot.box.y < o.box.y + o.box.h && o.box.y < spot.box.y + spot.box.h).toBe(false)
    }
  })

  it('takes its second shape where its first has no clean spot', () => {
    const own: SkyDisc = { id: 'a', x: 800, y: 500, r: 20 }
    // A wide plate runs off the picture on the far side and under bodies on every other; a narrow, taller one fits beside its body.
    const crowd: SkyDisc[] = [-1, 1].flatMap((side) => [0, 1, 2, 3].map((i) => ({ id: `c${side}${i}`, x: 640 + i * 45, y: 500 + side * 44, r: 4 })))
    const tight: SkyNameRoom = { ...room, view: { x: 0, y: 0, w: 900, h: 1000 } }
    const got = skyNames([{ id: 'a', shapes: [{ w: 150, h: 20 }, { w: 74, h: 36 }] }], [own, ...crowd], tight).get('a')!
    expect(got.shape).toBe(1)
    expect(got.box.w).toBe(74)
  })

  it('names both of two large bodies that stand side by side, each plainly its own, one of them on a tie line if it must', () => {
    // Two large bodies almost touching, dots round them: the arrangement the mistake was seen in.
    const guide: SkyDisc = { id: 'guide', x: 300, y: 200, r: 28 }
    const ops: SkyDisc = { id: 'ops', x: 366, y: 204, r: 26 }
    const dots: SkyDisc[] = [[250, 130], [330, 140], [410, 150], [250, 270], [340, 275], [420, 260], [220, 200]].map(([x, y], i) => ({ id: `d${i}`, x: x!, y: y!, r: 5, minor: true }))
    const discs = [guide, ops, ...dots]
    const got = skyNames([ask('guide', [20, 40, 70]), ask('ops', [20, 40, 70])], discs, room)
    expect([...got.keys()].sort()).toEqual(['guide', 'ops'])
    for (const [id, spot] of got) {
      const own = discs.find((d) => d.id === id)!
      // Neither name is as near the other large body as it is to its own.
      for (const d of [guide, ops]) if (d.id !== id) expect(gap(spot.box, d), `${id}'s name is nearer ${d.id}`).toBeGreaterThan(Math.max(0, gap(spot.box, own)))
    }
  })

  it('keeps a name out of another large body\'s caption zone: the lower right of a diagonal pair is never named under the upper left one', () => {
    // As seen live: two large bodies diagonal and nearly touching, the guide up and to the left, operations down and to the right.
    const guide: SkyDisc = { id: 'guide', x: 300, y: 200, r: 30 }
    const ops: SkyDisc = { id: 'ops', x: 348, y: 244, r: 28 }
    const spot = skyNames([ask('ops', [20, 40])], [guide, ops], room).get('ops')!
    // The spot left of and below its own body, touching it, lies straight under the guide: it is not taken, though its own body is the nearer.
    const underGuide = Math.max(0, Math.min(spot.box.x + spot.box.w, guide.x + guide.r) - Math.max(spot.box.x, guide.x - guide.r))
    expect(spot.box.y >= guide.y && underGuide > spot.box.w / 4).toBe(false)
    // It stands on the side that faces away from the guide: right of its body, or below and to the right.
    expect(spot.box.x + spot.box.w / 2).toBeGreaterThan(ops.x)
    expect(spot.tied).toBe(false)
    // And the guide's own name does not land beside or over operations either.
    const both = skyNames([ask('guide', [20, 40]), ask('ops', [20, 40])], [guide, ops], room)
    const g = both.get('guide')!
    expect(g.box.x + g.box.w / 2).toBeLessThan(guide.x)
  })

  it('gives whoever is asked first the first pick', () => {
    const a: SkyDisc = { id: 'a', x: 700, y: 500, r: 20 }
    const b: SkyDisc = { id: 'b', x: 700, y: 600, r: 20 }
    const first = skyNames([ask('a'), ask('b')], [a, b], room).get('a')!
    const second = skyNames([ask('b'), ask('a')], [a, b], room).get('a')!
    // Asked first, a takes its far side from the sun, touching.
    expect(first.tied).toBe(false)
    expect(first.box.x).toBeCloseTo(700 + 20 + 4, 6)
    expect(second.box).toBeDefined()
  })

  it('leaves a name out when no spot is clean, and names the next one all the same', () => {
    const own: SkyDisc = { id: 'a', x: 300, y: 300, r: 20 }
    // Bodies all round it, nearer than any name could clear.
    const ring: SkyDisc[] = Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, x: 300 + Math.cos((i * Math.PI) / 8) * 60, y: 300 + Math.sin((i * Math.PI) / 8) * 60, r: 8 }))
    const far: SkyDisc = { id: 'b', x: 800, y: 800, r: 20 }
    const got = skyNames([ask('a'), ask('b')], [own, ...ring, far], room)
    expect(got.has('a')).toBe(false)
    expect(got.has('b')).toBe(true)
  })

  it('steps off on a tie line when no touching spot is clean, and lands the same every time', () => {
    const own: SkyDisc = { id: 'a', x: 700, y: 300, r: 20 }
    const other: SkyDisc = { id: 'b', x: 200, y: 800, r: 20 }
    // A frame kept clear close round the body, with one opening on its right: every touching spot lies on the frame, and a step out through the opening is free.
    const framed: SkyNameRoom = { ...room, keepOut: [{ x: 670, y: 270, w: 60, h: 6 }, { x: 670, y: 324, w: 60, h: 6 }, { x: 670, y: 270, w: 6, h: 60 }, { x: 724, y: 270, w: 6, h: 24 }, { x: 724, y: 306, w: 6, h: 24 }] }
    const got = skyNames([ask('a'), ask('b')], [own, other], framed)
    expect(got.get('a')!.tied).toBe(true)
    expect(gap(got.get('a')!.box, own)).toBeCloseTo(20, 6)
    expect(got.get('b')!.tied).toBe(false)
    expect([...skyNames([ask('a'), ask('b')], [other, own], framed)]).toEqual([...got])
  })
})

describe('growing land', () => {
  it('grows each group to its size, no two on one cell', () => {
    const cells = grow(
      [
        { seed: hexCenter(-6, 0, 10), target: 30 },
        { seed: hexCenter(6, 0, 10), target: 12 },
      ],
      10,
      () => true,
    )
    expect(cells.map((c) => c.length)).toEqual([30, 12])
    expect(new Set(cells.flat().map(([q, r]) => hexKey(q, r))).size).toBe(42)
  })
})

describe('the islands of a ground', () => {
  const items = [...['a/x/1', 'a/x/2', 'a/x/3', 'a/x/4'], ...['b/y/1', 'b/y/2', 'b/y/3'], 'c/z/1', 'loose'].map((key) => ({ key }))
  const arch = archipelagoOf(items)

  it('makes one island a folder, the biggest first, and gathers the folders of a few on one more', () => {
    expect(arch.islands.map((i) => [i.folder, i.items.length])).toEqual([
      ['a/x', 4],
      ['b/y', 3],
      [null, 2],
    ])
    expect(arch.cells).toHaveLength(items.length)
  })

  it("reads a key's folder as all of it but its last segment", () => {
    expect(folderOf('azuredevops/acme/web/api')).toBe('azuredevops/acme/web')
    expect(folderOf('api')).toBe('')
  })
})

describe('labels', () => {
  it('takes the first free place, and leaves out a label with none', () => {
    const got = placeLabels([
      [{ x: 0, y: 0, w: 10, h: 10 }],
      [
        { x: 5, y: 5, w: 10, h: 10 },
        { x: 20, y: 0, w: 10, h: 10 },
      ],
      [{ x: 0, y: 0, w: 30, h: 10 }],
    ])
    expect(got).toEqual([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }, null])
  })

  it('lets a land carry its own name but keeps others off it, and keeps every name on the picture', () => {
    const land = { x: 0, y: 0, w: 20, h: 20, owner: 0 }
    expect(placeLabels([[{ x: 5, y: 5, w: 5, h: 5 }], [{ x: 5, y: 5, w: 5, h: 5 }]], [land])).toEqual([{ x: 5, y: 5, w: 5, h: 5 }, null])
    expect(placeLabels([[{ x: -5, y: 0, w: 10, h: 5 }]], [], 0, { x: 0, y: 0, w: 100, h: 100 })).toEqual([null])
  })

  it('fans out markers that sit on each other, and leaves one alone where it is', () => {
    const out = fanOut(
      [
        [0, 0],
        [1, 0],
        [100, 100],
      ],
      10,
    )
    expect(Math.hypot(out[0]![0] - out[1]![0], out[0]![1] - out[1]![1])).toBeGreaterThanOrEqual(10)
    expect(out[2]).toEqual([100, 100])
  })

  it('breaks a long name only at its punctuation, never inside a word or between the humps of camel case', () => {
    expect(breakable('CometRedirectService')).toBe('CometRedirectService')
    expect(breakable('cm.cmr.api')).toBe('cm.​cmr.​api')
  })
})

describe('the route of the rounds', () => {
  it("walks island by island in the order of each island's first stop, never back to one it left", () => {
    const items = ['a/x/1', 'a/x/2', 'a/x/3', 'b/y/1', 'b/y/2', 'b/y/3', 'c/1'].map((key) => ({ key }))
    const rounds = ['a/x/1', 'b/y/1', 'a/x/2', 'c/1', 'b/y/2'].map((key) => ({ key }))
    expect(routeOrder(rounds, items).map((r) => r.key)).toEqual(['a/x/1', 'a/x/2', 'b/y/1', 'b/y/2', 'c/1'])
  })
})

describe('leader lines', () => {
  const box = { x: 10, y: 10, w: 20, h: 10 }
  it('says a line through a box runs into it, and one that passes by does not', () => {
    expect(lineHits([0, 15], [40, 15], box)).toBe(true)
    expect(lineHits([0, 0], [40, 0], box)).toBe(false)
    expect(lineHits([0, 30], [5, 25], box)).toBe(false)
    // A line that ends inside the box runs into it.
    expect(lineHits([0, 15], [15, 15], box)).toBe(true)
  })
  it('widens the box by the gap', () => {
    expect(lineHits([0, 8], [40, 8], box)).toBe(false)
    expect(lineHits([0, 8], [40, 8], box, 3)).toBe(true)
  })
  it('meets a box at the point nearest where it starts', () => {
    expect(nearestOn(box, [0, 0])).toEqual([10, 10])
    expect(nearestOn(box, [20, 50])).toEqual([20, 20])
    expect(nearestOn(box, [15, 15])).toEqual([15, 15])
  })
})

describe('a flower', () => {
  const ladders = [
    { id: 'secure', title: 'Secure', rungs: ['Bronze', 'Silver', 'Gold'] },
    { id: 'observed', title: 'Observed', rungs: ['Bronze', 'Silver', 'Gold'] },
  ]
  const on = (ladder: string, states: ('pass' | 'fail' | 'unknown')[]) => states.map((state, rung) => ({ kind: 'scorecard' as const, id: `${ladder}${rung}`, title: 'r', of: null, state, ladder, rung }))
  const top = { checks: on('secure', ['pass', 'pass', 'pass']) }
  const short = { checks: on('secure', ['pass', 'fail', 'fail']) }
  const blind = { checks: on('secure', ['pass', 'unknown', 'pass']) }

  it('draws one thing as a slim petal a ladder it is read on, the ghost of a full one behind, and a stub where a ladder reads it not', () => {
    const f = flowerOf([short], ladders, 40)
    expect(f.petals.map((p) => [p.ladder, p.kind])).toEqual([['secure', 'short']])
    expect(f.ghosts.map((g) => [g.ladder, g.grows])).toEqual([['secure', false]])
    expect(f.stubs.map((x) => x.ladder)).toEqual(['observed'])
    expect(f.rings).toEqual([])
  })

  it('stands the first ladder straight up, so a petal means the same ladder on every flower', () => {
    const f = flowerOf([top], ladders, 40)
    const tip = f.petals[0]!.d.match(/Q[^Q]+Q/)![0]
    // The tip of the first petal is above the heart, on its middle line.
    const [, x, y] = tip.match(/ (\S+) (\S+)Q$/)!.map(Number)
    expect(x).toBeCloseTo(42, 0)
    expect(y).toBeCloseTo(2, 0)
  })

  it('joins the things on the same rung into one petal, the lowest first, and keeps a break apart from no data', () => {
    const f = flowerOf([top, short, short, blind, top], ladders, 60)
    expect(f.petals.map((p) => p.kind)).toEqual(['short', 'blind', 'top'])
    expect(f.rings).toHaveLength(3)
  })

  it('draws in gold only what a plan grows: a broken climb, never one stopped by no data', () => {
    const f = flowerOf([short, blind], ladders, 60, () => true)
    expect(f.ghosts.map((g) => g.grows)).toEqual([true])
  })
})
