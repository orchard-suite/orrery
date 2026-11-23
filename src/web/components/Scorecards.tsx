// The scorecards, read through one lens: the reader's own when the hub marks
// any scored row as theirs, else everything they may see (`lensOf`). The
// board on the left ranks every scorecard by how far up its ladder the
// lens's entities stand, under a verdict for the lens as a whole; in the
// reader's own lens, a scorecard that scores nothing of theirs is folded
// under the rest. The page says what to do next only to a reader who can do
// it (`advises`): elsewhere it says how things stand. The right side is the picked scorecard: its own
// verdict, a staircase of how many reach each level with the rule that holds
// the most back at every step, and its entities against its rules in a grid
// that scrolls inside itself. With no scorecard picked, the right side lists
// the single fixes that would lift the most across the estate. On a desk the
// page fills the window; every list scrolls inside itself.

import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowLeft, ArrowRight, CircleCheck, CircleHelp, Layers, CircleX, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import type { Scorecard, ScorecardResults, ScorecardRow } from '../../shared/api.ts'
import { entityId, type Blueprint } from '../../shared/model.ts'
import { blueprintsOf, partsOf } from '../../shared/scorecard.ts'
import { useBlueprintName, useBlueprints, useCan, useDeleteScorecard, useMine, useSaveScorecard, useScorecardReadings, useScorecards } from '../api.ts'
import { BlueprintIcon } from '../icons.tsx'
import { middle } from '../format.ts'
import { navigate, type Route } from '../router.ts'
import { advises, atTop, groupLifts, lensOf, scopeWords, liftsOf, movement, readingOf, rulesOf, standing, standingByDay, topsOf, yoursOf, type Lens, type Lift, type Reading } from '../scorecards.ts'
import { fixField } from '../fix.ts'
import { Drawer } from './Drawer.tsx'
import { FixMark } from './FixValue.tsx'
import { PhoneBar } from './PhoneBar.tsx'
import { Badge, Button, chipStyle, ErrorNote, input, Link, useDesk, useNarrow } from './ui.tsx'
import { useEscape } from '../layers.ts'
import { PAGE_ICON } from '../title.ts'
import { useHere, useVisit } from '../trail.ts'

/** The way up to every scorecard on a phone, drawn as its page, so it is never taken for Back. */
const EveryScorecard = PAGE_ICON.scorecards

/** A level's colour by its place on the ladder of `of` levels: no level (-1) apart, the top always the brightest. */
export function levelColor(level: number, of: number): string {
  if (level < 0) return 'var(--color-level-none)'
  const share = of <= 1 ? 100 : Math.round((level / (of - 1)) * 100)
  return `color-mix(in oklab, var(--color-level-top) ${share}%, var(--color-level-low))`
}

/** A level's name in its colour. `index` counts no level as 0; `of` is how many levels the ladder has. */
export function LevelPill({ name, index, of }: { name: string; index: number; of: number }) {
  const color = levelColor(index - 1, of)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-px text-[12px] font-medium whitespace-nowrap" style={chipStyle(color)}>
      <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {name}
    </span>
  )
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0)
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** One scorecard as the page reads it, once its results are in. */
interface Card {
  sc: Scorecard
  results: ScorecardResults
  reading: Reading
  byDay: (number | null)[] | null
  lifts: Lift[]
  /** Narrowed to the reader's own: the hub keeps one history a scorecard, so the standing of theirs has no trend to draw. */
  trendless?: true
}

/** The reader's own rows of a card, read again: its counts, standing, and fixes are theirs alone. */
function narrowed(c: Card): Card {
  const results = yoursOf(c.results)
  return { sc: c.sc, results, reading: readingOf(results), byDay: null, lifts: liftsOf(c.sc, results.rows), trendless: true }
}

/** How the page reads for this reader: through which lens, whether they have their own, whether it advises, and how it names what it reads. */
interface Reader {
  lens: Lens
  owns: boolean
  advice: boolean
  seesAll: boolean
  words: { what: string; all: string; band: string; wide: string }
}

function wordsOf(lens: Lens, seesAll: boolean): Reader['words'] {
  const wide = seesAll ? 'The estate' : 'All you can see'
  if (lens === 'yours') return { what: 'of what you own', all: 'Everything you own', band: 'Every score of yours', wide }
  if (!seesAll) return { what: 'of what you can see', all: 'Everything you can see', band: 'Every score you can see', wide }
  return { what: 'of what is scored', all: 'Everything scored', band: 'Every score in the estate', wide }
}

/** The lens the reader asked for in the address, carried by every link the page draws, so a move between scorecards keeps it. */
const Asked = createContext<Lens | undefined>(undefined)

/** A link to the scorecards page in the lens the reader asked for. */
function useTo() {
  const lens = useContext(Asked)
  return (id: string | null, fix?: { kind: string; rule: string }): Route => ({ page: 'scorecards', id, ...(fix ? { fix } : {}), ...(lens ? { lens } : {}) })
}

/** The one control between the reader's own and everything they may see, shown only to a reader who has their own. */
function LensSwitch({ reader, id, className = '' }: { reader: Reader; id: string | null; className?: string }) {
  if (!reader.owns) return null
  const choices: { lens: Lens; label: string }[] = [
    { lens: 'yours', label: 'Yours' },
    { lens: 'wide', label: reader.words.wide },
  ]
  return (
    <div role="group" aria-label="Whose" className={`flex w-fit rounded-md border border-ink-700 bg-ink-850 p-0.5 text-[12px] font-medium ${className}`}>
      {choices.map((o) => (
        <Link key={o.lens} to={{ page: 'scorecards', id, ...(o.lens === 'wide' ? { lens: 'wide' as const } : {}) }} current={reader.lens === o.lens} className={`grid min-h-6 place-items-center rounded px-2 ${reader.lens === o.lens ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}>
          {o.label}
        </Link>
      ))}
    </div>
  )
}

export function Scorecards({ id, fix, lens: asked }: { id: string | null; fix: { kind: string; rule: string } | null; lens?: Lens }) {
  const list = useScorecards()
  const blueprints = useBlueprints().data?.blueprints ?? []
  const canAuthor = useCan('model.edit')
  const narrow = useNarrow()
  const [editing, setEditing] = useState<{ id?: string; text: string } | null>(null)
  const scorecards = list.data?.scorecards ?? []
  useHere(id ? scorecards.find((s) => s.id === id)?.title : null)
  const readings = useScorecardReadings(scorecards.map((s) => s.id))
  const full = useMemo(
    () =>
      readings.flatMap(({ results, trend }): Card[] => {
        if (!results.data) return []
        const sc = results.data.scorecard
        return [
          {
            sc,
            results: results.data,
            reading: readingOf(results.data),
            byDay: trend.data ? standingByDay(trend.data) : null,
            lifts: liftsOf(sc, results.data.rows),
          },
        ]
      }),
    // The readings change identity every render; their data does not.
    [readings.map((r) => `${r.results.dataUpdatedAt}:${r.trend.dataUpdatedAt}`).join()],
  )
  const seesAll = useMine().data?.seesAll ?? false
  const { lens, owns } = lensOf(
    full.map((c) => c.results),
    asked,
  )
  const reader: Reader = { lens, owns, advice: advises(lens, seesAll), seesAll, words: wordsOf(lens, seesAll) }
  // In the reader's own lens, a card that scores something of theirs is read for theirs alone; one that scores only others' is folded apart.
  const { cards, others } = useMemo(() => {
    if (lens === 'wide') return { cards: full, others: [] }
    const mine = (c: Card) => c.results.rows.some((r) => !!r.yours)
    return { cards: full.filter((c) => !c.reading.scored || mine(c)).map((c) => (c.reading.scored ? narrowed(c) : c)), others: full.filter((c) => c.reading.scored && !mine(c)) }
  }, [full, lens])
  const current = scorecards.find((s) => s.id === id) ?? null
  const card = cards.find((c) => c.sc.id === id) ?? others.find((c) => c.sc.id === id) ?? null
  const error = list.error ?? readings.find((r) => r.results.error)?.results.error
  const startNew = () => setEditing({ text: TEMPLATE })
  return (
    <Asked.Provider value={asked}>
      <div className={`grid grid-cols-[minmax(0,1fr)] gap-y-6 pt-4 pb-8 md:pt-6 desk:h-full desk:grid-rows-[minmax(0,1fr)] desk:pb-6 ${current ? 'gap-x-6 xl:grid-cols-[minmax(248px,264px)_minmax(0,1fr)]' : 'gap-x-8 xl:grid-cols-[minmax(300px,340px)_minmax(0,1fr)]'}`}>
        {/* Below a desk the board gives way to the scorecard picked; the back link leads to it again. */}
        <aside aria-label="Scorecards" className={`min-h-0 flex-col gap-5 ${current ? 'hidden xl:flex' : 'flex'}`}>
          <Estate cards={cards} reader={reader} id={id} total={scorecards.length} heading={!current} onNew={canAuthor ? startNew : null} />
          {!current && <EstateBand cards={cards} reader={reader} className="xl:hidden" />}
          <Board cards={cards} others={others} reader={reader} pending={scorecards.filter((s) => !full.some((c) => c.sc.id === s.id))} current={id} />
        </aside>
        <section aria-label={current ? current.title : 'Where one fix lifts the most'} className="min-h-0 min-w-0">
          <ErrorNote error={error} />
          {current ? card ? <CardView card={card} reader={reader} notYours={others.includes(card)} fix={fix} blueprints={blueprints} canAuthor={canAuthor} narrow={narrow} onEdit={() => setEditing({ id: card.sc.id, text: specOf(card.sc) })} /> : <div className="py-12 text-sm text-ink-400">Scoring {current.title}…</div> : <EstateLifts cards={cards} reader={reader} blueprints={blueprints} />}
        </section>
        {editing && <Editor initial={editing.text} id={editing.id} onDone={() => setEditing(null)} />}
      </div>
    </Asked.Provider>
  )
}

/** The lens's verdict: how much of what it reads reaches no level, and, to a reader who can act on it, the one fix that lifts the most. */
function Estate({ cards, reader, id, total, heading, onNew }: { cards: Card[]; reader: Reader; id: string | null; total: number; heading: boolean; onNew: (() => void) | null }) {
  const name = useBlueprintName()
  const to = useTo()
  const scored = cards.reduce((n, c) => n + c.reading.scored, 0)
  const none = cards.reduce((n, c) => n + c.reading.none, 0)
  // The estate counts the top of each ladder, as the kept trend does, so today's share and the trend's last day agree.
  const top = cards.reduce((n, c) => n + (c.reading.counts.at(-1) ?? 0), 0)
  const fixOf = (c: Card) => {
    const g = groupLifts(c.lifts)[0]
    return g ? [{ g, c }] : []
  }
  const best = cards.flatMap(fixOf).sort((a, b) => b.g.lifts - a.g.lifts)[0]
  // The weakest scorecard's own first fix, when it is not the one above.
  const weakest = cards.filter((c) => c.reading.scored).sort((a, b) => a.reading.standing - b.reading.standing)[0]
  const weakFix = weakest ? fixOf(weakest)[0] : undefined
  const weakestMove = weakest?.byDay ? movement(weakest.byDay) : null
  const weakestMoved = weakestMove ? Math.round(weakestMove.change * 100) : 0
  const weak = weakFix && !(weakFix.c === best?.c && weakFix.g.title === best.g.title) ? weakFix : undefined
  const Heading = heading ? 'h1' : 'p'
  const now = pct(none, scored)
  return (
    <header className="shrink-0">
      <div className="flex items-center gap-2">
        <p className="label">
          Scorecards · {total} · {plural(scored, 'score')}
        </p>
        {onNew && (
          <button type="button" className="btn btn-ghost ml-auto px-2 py-1" onClick={onNew}>
            <Plus className="size-3.5" aria-hidden /> New
          </button>
        )}
      </div>
      <LensSwitch reader={reader} id={id} className="mt-2" />
      {cards.length > 0 && (
        <>
          <Heading className="mt-2 font-serif text-[30px] leading-[1.1] tracking-[-0.01em] text-balance text-ink-50">
            {none ? (
              <>
                <span className="italic">{now}%</span> {reader.words.what} reaches no level.
              </>
            ) : (
              <>{reader.words.all} reaches a level.</>
            )}
          </Heading>
          <p className="mt-2 text-[13px] leading-relaxed text-pretty text-ink-300">
            {pct(top, scored)}% stands at the top of its ladder.
            {weakest && (
              <>
                {' '}
                The weakest scorecard,{' '}
                <Link to={to(weakest.sc.id)} className="font-medium text-ink-100 underline decoration-ink-600 underline-offset-2 hover:decoration-ink-300">
                  {weakest.sc.title}
                </Link>
                , stands at <span className="font-semibold text-red tabular-nums">{Math.round(weakest.reading.standing * 100)}</span> of 100
                {weakest.trendless ? '' : weakestMoved ? (weakestMoved > 0 ? `, up ${weakestMoved} in 30 days` : `, down ${-weakestMoved} in 30 days`) : weakest.byDay && movement(weakest.byDay) ? ', flat over 30 days' : ', with no history yet'}.
              </>
            )}
          </p>
          {/* With a card open, the card's own verdict names its fix; the call is for the lens, and only to a reader who can make it. */}
          {best && heading && reader.advice && (
            <div className="mt-3 overflow-hidden rounded-lg border border-orbit/50 bg-ink-850">
              <Link to={to(best.c.sc.id, { kind: best.g.parts[0]!.blueprint, rule: best.g.parts[0]!.rule.id })} className="group flex items-center gap-3 px-3 py-2.5 hover:bg-ink-800">
                <span className="min-w-0 flex-1">
                  <span className="label block text-pretty">{`Next, the fix that lifts the most${best.c === weakest ? ', on the weakest scorecard' : ''}`}</span>
                  <span className="mt-0.5 block text-[14px] font-medium text-ink-50">{best.g.title}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-300">
                    <span className="font-semibold text-ink-100 tabular-nums">+{best.g.lifts.toLocaleString()}</span> {best.g.parts.length === 1 ? name(best.g.parts[0]!.blueprint) : plural(best.g.parts.length, 'kind')} to {best.c.sc.levels[best.g.level]!.name} on {best.c.sc.title}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-orbit transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
              {weak && (
                <Link to={to(weak.c.sc.id, { kind: weak.g.parts[0]!.blueprint, rule: weak.g.parts[0]!.rule.id })} className="flex items-baseline gap-2 border-t border-ink-700 px-3 py-2 text-[12px] text-ink-300 hover:bg-ink-800">
                  <span className="label shrink-0">On the weakest</span>
                  <span className="min-w-0">
                    <span className="font-medium text-ink-100">{weak.g.title}</span> <span className="font-semibold text-ink-100 tabular-nums">+{weak.g.lifts.toLocaleString()}</span> on {weak.c.sc.title}
                  </span>
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </header>
  )
}

/** Every scorecard, weakest first by its standing: how far up its ladder its entities stand, out of 100. In the reader's own lens, the cards that score nothing of theirs fold under the rest. */
function Board({ cards, others, reader, pending, current }: { cards: Card[]; others: Card[]; reader: Reader; pending: Scorecard[]; current: string | null }) {
  const name = useBlueprintName()
  const to = useTo()
  // In the wide lens, how many of the reader's own stand below the top of each card; in their own lens every row is theirs.
  const yoursBelow = (c: Card) => {
    const tops = topsOf(c.sc)
    return reader.owns && reader.lens === 'wide' ? c.results.rows.filter((r) => !!r.yours && !atTop(r, tops)).length : 0
  }
  // Open while the reader is on one of them, so the card picked is always in sight.
  const [unfolded, setUnfolded] = useState(false)
  const showOthers = unfolded || others.some((c) => c.sc.id === current)
  // Weakest first, or largest first to see which cards weigh most; a scorecard that scores nothing has no standing to rank and waits below the rest.
  const [by, setBy] = useVisit<'weakest' | 'largest'>('scorecards.by', 'weakest')
  const weakest = cards.filter((c) => c.reading.scored).sort((a, b) => a.reading.standing - b.reading.standing || a.sc.title.localeCompare(b.sc.title))[0]
  const ranked = cards.filter((c) => c.reading.scored).sort((a, b) => (by === 'weakest' ? a.reading.standing - b.reading.standing : b.reading.scored - a.reading.scored) || a.sc.title.localeCompare(b.sc.title))
  // A phone shows the first few until asked, and always the one open.
  const narrow = useNarrow()
  const [all, setAll] = useState(false)
  const shown = narrow && !all ? ranked.filter((c, i) => i < 6 || c.sc.id === current) : ranked
  const idle = cards.filter((c) => !c.reading.scored)
  // The scorecard picked stays in sight in the board, wherever it ranks.
  const list = useRef<HTMLElement>(null)
  const ready = cards.length
  useEffect(() => {
    list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' })
  }, [current, ready])
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-ink-700 bg-ink-900">
      <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-ink-700 px-4 pt-3 pb-2">
        <div role="group" aria-label="Order" className="flex rounded-md border border-ink-700 bg-ink-850 p-0.5 text-[12px] font-medium">
          {(['weakest', 'largest'] as const).map((o) => (
            <button key={o} type="button" aria-pressed={by === o} onClick={() => setBy(o)} className={`min-h-6 rounded px-2 ${by === o ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}>
              {o === 'weakest' ? (current ? 'Weakest' : 'Weakest first') : current ? 'Largest' : 'Largest first'}
            </button>
          ))}
        </div>
        <span className="label whitespace-nowrap" title="How far up its ladder a scorecard's entities stand on the whole, of 100, and its change over 30 days.">
          {current || reader.lens === 'yours' ? 'Standing' : 'Standing · 30 days'}
        </span>
      </div>
      <nav ref={list} aria-label={by === 'weakest' ? 'Scorecards, weakest first' : 'Scorecards, largest first'} className="min-h-0 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)] desk:flex-1">
        <ul>
          {shown.map((c) => {
            const moved = c.byDay && movement(c.byDay)
            const isWeakest = c === weakest && ranked.length > 1
            const kinds = blueprintsOf(c.sc)
            const on = c.sc.id === current
            return (
              <li key={c.sc.id} className="border-b border-ink-800 last:border-b-0">
                <Link to={to(c.sc.id)} current={on} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 ${on ? 'bg-ink-800 shadow-[inset_2px_0_0_var(--color-orbit)]' : 'hover:bg-ink-850'}`}>
                  <span className="text-[14px] font-medium text-ink-100">{c.sc.title}</span>
                  <span className={`text-right text-[18px] leading-none font-semibold tabular-nums ${isWeakest ? 'text-red' : 'text-ink-50'}`}>{Math.round(c.reading.standing * 100)}</span>
                  <Ladder levels={c.sc.levels.map((l) => l.name)} counts={c.reading.counts} track className="h-2" />
                  {c.trendless ? <span aria-hidden /> : <Moved moved={moved ?? null} />}
                  <span className={`col-span-2 text-[12px] text-ink-400 ${current ? 'hidden' : ''}`}>
                    {isWeakest && <span className="mr-1.5 font-medium text-red">Weakest ·</span>}
                    {kinds.length > 1 ? plural(kinds.length, 'kind') : name(kinds[0] ?? '')} · {plural(c.reading.scored, 'entity', 'entities')} · {plural(c.sc.levels.length, 'level')}
                    {yoursBelow(c) > 0 && <span className="block text-orbit">{yoursBelow(c).toLocaleString()} of yours below the top</span>}
                  </span>
                </Link>
              </li>
            )
          })}
          {shown.length < ranked.length && (
            <li>
              <button type="button" className="min-h-11 w-full px-4 text-left text-[13px] font-medium text-orbit" onClick={() => setAll(true)}>
                All {ranked.length} scorecards
              </button>
            </li>
          )}
          {pending.map((s) => (
            <li key={s.id} className="border-b border-ink-800 px-4 py-2.5 text-[14px] text-ink-400 last:border-b-0">
              {s.title} <span className="text-[12px]">· scoring…</span>
            </li>
          ))}
        </ul>
        {idle.length > 0 && (
          <>
            <h3 className="border-y border-ink-700 bg-ink-850 px-4 py-1.5 text-[12px] font-medium text-ink-400">Not scoring anything yet</h3>
            <ul>
              {idle.map((c) => (
                <li key={c.sc.id} className="border-b border-ink-800 last:border-b-0">
                  <Link to={to(c.sc.id)} current={c.sc.id === current} className={`flex items-baseline justify-between gap-3 px-4 py-2 text-[13px] ${c.sc.id === current ? 'bg-ink-800 shadow-[inset_2px_0_0_var(--color-orbit)]' : 'hover:bg-ink-850'}`}>
                    <span className="font-medium text-ink-200">{c.sc.title}</span>
                    <span className="text-[12px] text-ink-400">{c.results.outOfScope ? `${c.results.outOfScope.toLocaleString()} out of scope` : 'nothing to score'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <h3 className="border-y border-ink-700 bg-ink-850">
              <button type="button" aria-expanded={showOthers} onClick={() => setUnfolded((o) => !o)} className="flex min-h-8 w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-[12px] font-medium text-ink-400 hover:text-ink-200">
                Nothing of yours scored · {others.length}
                <ArrowRight className={`size-3.5 shrink-0 ${showOthers ? 'rotate-90' : ''}`} aria-hidden />
              </button>
            </h3>
            {showOthers && (
              <ul>
                {others.map((c) => (
                  <li key={c.sc.id} className="border-b border-ink-800 last:border-b-0">
                    <Link to={to(c.sc.id)} current={c.sc.id === current} className={`flex items-baseline justify-between gap-3 px-4 py-2 text-[13px] ${c.sc.id === current ? 'bg-ink-800 shadow-[inset_2px_0_0_var(--color-orbit)]' : 'hover:bg-ink-850'}`}>
                      <span className="font-medium text-ink-200">{c.sc.title}</span>
                      <span className="text-[12px] whitespace-nowrap text-ink-400 tabular-nums">{plural(c.reading.scored, 'entity', 'entities')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </nav>
    </div>
  )
}

/** How the standing moved over the days kept, in points out of 100. */
function Moved({ moved, className = 'w-12 text-right' }: { moved: { change: number; days: number } | null; className?: string }) {
  if (!moved) return <span className={`text-[12px] text-ink-400 ${className}`}>new</span>
  const points = Math.round(moved.change * 100)
  const over = `over ${plural(moved.days, 'day')}`
  if (!points)
    return (
      <span className={`text-[12px] whitespace-nowrap text-ink-400 ${className}`} title={`No change ${over}`}>
        flat
      </span>
    )
  return (
    <span className={`text-[12px] whitespace-nowrap tabular-nums ${className} ${points > 0 ? 'text-green' : 'text-red'}`} title={`${points > 0 ? 'Up' : 'Down'} ${Math.abs(points)} ${over}`}>
      {points > 0 ? '▲' : '▼'} {Math.abs(points)}
      <span className="sr-only"> points {over}</span>
    </span>
  )
}

/** Where a scorecard's entities stand: one bar split by level, the top first. As a `track`, no level is the bar's empty part, so what has climbed stands out. */
function Ladder({ levels, counts, track = false, className = '' }: { levels: string[]; counts: number[]; track?: boolean; className?: string }) {
  const of = levels.length
  const names = ['No level', ...levels]
  const order = names.map((_, i) => i).reverse()
  return (
    <span role="img" aria-label={order.map((i) => `${names[i]}: ${counts[i] ?? 0}`).join(', ')} className={`flex gap-0.5 overflow-hidden rounded-[3px] bg-ink-800 ${className}`}>
      {order.map((i) =>
        counts[i] ? (
          <span
            key={i}
            className="block min-w-[3px]"
            title={`${names[i]}: ${counts[i]!.toLocaleString()}`}
            style={{
              flex: `${counts[i]} 0 0`,
              background: i === 0 && track ? 'transparent' : levelColor(i - 1, of),
              backgroundImage: i === 0 ? (track ? FAINT_HATCH : HATCH) : undefined,
            }}
          />
        ) : null,
      )}
    </span>
  )
}

/** No level is drawn hatched, so it never reads as a level of its own even where its colour is close to one. */
/** A rule's name inside a sentence: marked, so where it ends is plain. */
const RULE = 'font-medium text-ink-100 underline decoration-ink-600 underline-offset-2'

const HATCH = 'repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in oklab, var(--color-ink-950) 45%, transparent) 3px 5px)'
/** No level on a track: a quiet hatch in the level's grey, so its size still reads without drawing the eye. */
const FAINT_HATCH = 'repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in oklab, var(--color-level-none) 55%, transparent) 3px 4.5px)'

/** With no scorecard picked: the single fixes that would lift the most, across every scorecard. */
/**
 * Every score in the estate in one bar: none reached, partway up a ladder,
 * at the top of it. Beside it, the share at the top and the share at no
 * level over the last 30 days, summed across every scorecard.
 */
function EstateBand({ cards, reader, className = '' }: { cards: Card[]; reader: Reader; className?: string }) {
  const to = useTo()
  const scored = cards.reduce((n, c) => n + c.reading.scored, 0)
  if (!scored) return null
  const none = cards.reduce((n, c) => n + c.reading.none, 0)
  // The estate counts the top of each ladder, as the headline does.
  const top = cards.reduce((n, c) => n + (c.reading.counts.at(-1) ?? 0), 0)
  const parts = [
    { name: 'At the top', count: top, color: 'var(--color-level-top)' },
    { name: 'Partway', count: scored - top - none, color: 'var(--color-level-low)' },
    { name: 'No level', count: none, color: 'var(--color-level-none)', hatch: true },
  ]
  // Each scorecard from its first kept day in the window to now, on the board's scale: every one compares with itself, so no card that joined late moves the rest.
  const moves = cards
    .flatMap((c) => {
      const kept = (c.byDay ?? []).filter((v): v is number => v !== null)
      const moved = c.byDay && movement(c.byDay)
      // The first and last day kept, the same span the board's change reads, so the two never disagree.
      return moved && kept.length ? [{ c, from: kept[0]!, to: kept.at(-1)!, days: moved.days }] : []
    })
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || a.to - b.to)
  // Scorecards with no day kept before today: listed, so the weakest is never missing from the picture.
  const fresh = cards.filter((c) => c.reading.scored && !moves.some((m) => m.c === c))
  const idle = cards.filter((c) => !c.reading.scored)
  const up = moves.filter((m) => Math.round(m.to * 100) > Math.round(m.from * 100)).length
  const down = moves.filter((m) => Math.round(m.to * 100) < Math.round(m.from * 100)).length
  return (
    <div className={`shrink-0 rounded-xl border border-ink-700 bg-ink-900 ${className}`}>
      <div className="grid gap-y-4 p-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink-100">{reader.words.band}</h2>
          <Ladder levels={['Partway', 'At the top']} counts={[none, scored - top - none, top]} className="mt-3 h-3" />
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-300">
            {parts.map((p) => (
              <li key={p.name} className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[2px]" style={{ background: p.color, backgroundImage: p.hatch ? HATCH : undefined }} aria-hidden />
                {p.name} <span className="font-semibold text-ink-50 tabular-nums">{p.count.toLocaleString()}</span>
                <span className="text-ink-400 tabular-nums">{pct(p.count, scored)}%</span>
              </li>
            ))}
          </ul>
        </div>
        {/* The hub keeps one history a scorecard, of everything it scores: it says nothing of the reader's own. */}
        {moves.length > 0 && reader.lens === 'wide' && (
          <figure className="min-w-0">
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12px] text-ink-400">
              <span className="text-[13px] font-semibold text-ink-100">30 days, card by card</span>
              <span>
                {plural(moves.length, 'scorecard')} kept: {up} up, {down} down
              </span>
            </figcaption>
            <ul className="mt-2 grid gap-x-6 gap-y-1 pr-1 sm:max-h-[11rem] sm:grid-cols-2 sm:overflow-y-auto sm:overscroll-contain">
              {moves.map((m) => {
                const points = Math.round(m.to * 100) - Math.round(m.from * 100)
                const tone = points > 0 ? 'var(--color-green)' : points < 0 ? 'var(--color-red)' : 'var(--color-ink-500)'
                return (
                  <li key={m.c.sc.id}>
                    <Link to={to(m.c.sc.id)} className="grid min-h-6 grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 rounded text-[12px] hover:bg-ink-850" title={`${m.c.sc.title}: ${Math.round(m.from * 100)} to ${Math.round(m.to * 100)} of 100 over ${plural(m.days, 'day')}`}>
                      <span className="text-ink-200">{m.c.sc.title}</span>
                      <span className="relative h-2.5" aria-hidden>
                        <span className="absolute inset-x-0 top-1/2 h-px bg-ink-700" />
                        {[0, 50, 100].map((t) => (
                          <span key={t} className="absolute top-0 h-full w-px bg-ink-600" style={{ left: `${t}%` }} />
                        ))}
                        <span className="absolute top-1/2 h-0.5 -translate-y-1/2" style={{ left: `${Math.min(m.from, m.to) * 100}%`, width: `${Math.abs(m.to - m.from) * 100}%`, background: tone }} />
                        <span className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${m.to * 100}%`, background: tone }} />
                        <span className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-ink-300" style={{ left: `${m.from * 100}%` }} />
                      </span>
                      <span className="text-right tabular-nums" style={{ color: tone }}>
                        {points > 0 ? '▲' : points < 0 ? '▼' : ''} {points ? Math.abs(points) : 'flat'}
                        {points !== 0 && <span className="sr-only"> points</span>}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
            <p className="mt-1.5 text-[12px] text-ink-400">
              Standing of 100 (ticks at 0, 50, 100), ring the first day kept, dot the last.
              {fresh.length > 0 && ` New, no history yet: ${fresh.map((c) => c.sc.title).join(', ')}.`}
              {idle.length > 0 && ` Not scoring yet: ${idle.map((c) => c.sc.title).join(', ')}.`}
            </p>
          </figure>
        )}
      </div>
    </div>
  )
}

/** The kinds a rule lifts on the index, as chips: the largest three, and how many more. */
function KindChips({ parts, blueprints }: { parts: Lift[]; blueprints: Blueprint[] }) {
  const name = useBlueprintName()
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {parts.slice(0, 2).map((l) => (
        <span key={l.blueprint} className={KIND_CHIP}>
          <BlueprintIcon bp={blueprints.find((b) => b.id === l.blueprint)} className="size-3 shrink-0" />
          {name(l.blueprint)}
          {parts.length > 1 && <span className="tabular-nums">+{l.lifts.toLocaleString()}</span>}
        </span>
      ))}
      {parts.length > 2 && <span className={MORE_CHIP}>+{parts.length - 2} kinds</span>}
    </span>
  )
}

/** A kind a fix lifts, and the chip that stands for the rest: one look on the index and on a card. */
const KIND_CHIP = 'inline-flex min-h-6 items-center gap-1 rounded-full border border-ink-700 px-2 text-[12px] text-ink-300'
const MORE_CHIP = 'inline-flex min-h-6 items-center rounded-full border border-dashed border-ink-600 px-2 text-[12px] text-ink-300'

/** How many of the estate's fixes show before the rest is asked for, where the list does not scroll inside itself. */
const FIRST_LIFTS = 4

function EstateLifts({ cards, reader, blueprints }: { cards: Card[]; reader: Reader; blueprints: Blueprint[] }) {
  const name = useBlueprintName()
  const to = useTo()
  // One line per rule on each card, however many kinds hold it. Where the page advises, the first is the call above, so the list goes on from the second.
  const from = reader.advice ? 1 : 0
  const lifts = cards
    .flatMap((c) => groupLifts(c.lifts).map((g) => ({ g, c })))
    .sort((a, b) => b.g.lifts - a.g.lifts)
    .slice(from, from + 40)
  const most = lifts[0]?.g.lifts ?? 1
  // On a desk the list scrolls inside itself; elsewhere it shows the first few, so the page ends.
  const desk = useDesk()
  const [more, setMore] = useState(false)
  const shown = desk || more ? lifts : lifts.slice(0, FIRST_LIFTS)
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <EstateBand cards={cards} reader={reader} className="hidden xl:block" />
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 desk:flex-1">
        <div className="shrink-0 border-b border-ink-700 px-4 pt-3 pb-2.5">
          <h2 className="font-serif text-[22px] leading-tight text-ink-50">{reader.advice ? 'After that, where one fix lifts the most' : 'Where one fix lifts the most'}</h2>
          <p className="mt-0.5 text-[12px] text-ink-400">One rule a line. Those counted fail it and nothing else at the level they stop at: fix it, and they move up a level.</p>
        </div>
        <ol className="min-h-0 overflow-y-auto overscroll-contain desk:flex-1">
          {shown.map(({ g, c }, i) => {
            const lead = g.parts[0]!
            return (
              <li key={`${c.sc.id}:${g.level}:${g.title}`} className="border-t border-ink-800 first:border-t-0">
                <Link to={to(c.sc.id, { kind: lead.blueprint, rule: lead.rule.id })} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-ink-850 md:grid-cols-[1.75rem_minmax(0,1fr)_auto_7rem]">
                  <span className="text-[12px] text-ink-400 tabular-nums">{i + from + 1}</span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-ink-100" title={lead.rule.description}>
                      {g.title}
                    </span>
                    {lead.rule.fix && <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-300">{lead.rule.fix}</span>}
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-400">
                      <span aria-hidden>→</span> <LevelPill name={c.sc.levels[g.level]!.name} index={g.level + 1} of={c.sc.levels.length} />
                      <span>on {c.sc.title}</span>
                    </span>
                    <KindChips parts={g.parts} blueprints={blueprints} />
                  </span>
                  <span className="text-right text-[13px] whitespace-nowrap tabular-nums">
                    <span className="font-semibold text-ink-50">+{g.lifts.toLocaleString()}</span>
                    <span className="text-ink-400"> of {g.failing.toLocaleString()} failing</span>
                  </span>
                  <span className="hidden md:block" aria-hidden>
                    <span className="block h-1.5 rounded-full bg-orbit" style={{ width: `${(g.lifts / most) * 100}%` }} />
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
        {shown.length < lifts.length && (
          <button type="button" className="w-full border-t border-ink-800 px-4 py-3 text-left text-[13px] font-medium text-orbit hover:bg-ink-850" onClick={() => setMore(true)}>
            Show all {lifts.length}
          </button>
        )}
        {cards.length > 0 && !lifts.length && <p className="px-4 py-8 text-center text-sm text-ink-400">Nothing is one rule away from its next level.</p>}
      </div>
    </div>
  )
}

/** What the grid shows: below the top or everything, and, from the ladder, only those that stop before a level. */
interface Filter {
  kind: string
  /** Below the top, or every entity of the kind. */
  show: 'below' | 'all'
  stopsBefore: number | null
  fails: string | null
  search: string
}

function CardView({ card, reader, notYours, fix, blueprints, canAuthor, narrow, onEdit }: { card: Card; reader: Reader; notYours: boolean; fix: { kind: string; rule: string } | null; blueprints: Blueprint[]; canAuthor: boolean; narrow: boolean; onEdit: () => void }) {
  const { sc, results, reading } = card
  const name = useBlueprintName()
  const to = useTo()
  const remove = useDeleteScorecard()
  const parts = partsOf(sc)
  // The kinds the rows hold: a lens that reads one kind of a card over several shows no list of kinds.
  const kinds = parts.map((p) => p.blueprint).filter((k) => !results.rows.length || results.rows.some((r) => r.entity.blueprint === k))
  // A scorecard over several kinds opens on its largest: each kind has its own rules, so the grid shows one at a time.
  const largest = [...kinds].sort((a, b) => results.rows.filter((r) => r.entity.blueprint === b).length - results.rows.filter((r) => r.entity.blueprint === a).length)[0] ?? ''
  // One rule's fix, from a link or the verdict: those who fail it, at the level it holds them back from.
  const onRule = (kind: string, rule: string): Filter => {
    const placed = rulesOf(sc).find((r) => r.blueprint === kind && r.rule.id === rule)
    return placed ? { kind, show: 'all', stopsBefore: placed.level, fails: rule, search: '' } : fresh
  }
  const fresh: Filter = { kind: largest, show: 'below', stopsBefore: null, fails: null, search: '' }
  const opened = `${sc.id}:${fix?.kind ?? ''}:${fix?.rule ?? ''}`
  // Each scorecard, and each rule's fix, has its own filter on the step.
  const [filter, setFilter] = useVisit<Filter>(`scorecard.${opened}.filter`, () => (fix ? onRule(fix.kind, fix.rule) : fresh))
  // The rule that lifts the most, across every kind that holds it.
  const leadGroup = groupLifts(card.lifts)[0]
  const lead = leadGroup?.parts[0]
  const removeCard = () => confirm(`Remove scorecard ${sc.id}?`) && remove.mutate(sc.id, { onSuccess: () => navigate(to(null)) })
  const out = results.outOfScope
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {narrow && (
        <PhoneBar>
          <Link to={to(null)} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-300" title="Every scorecard">
            <EveryScorecard className="size-5" aria-hidden />
            <span className="sr-only">Every scorecard</span>
          </Link>
          <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">Scorecards</span>
          {/* On a phone a card's own actions sit in the top bar, so its standing stays beside its verdict. */}
          {canAuthor && sc.origin.kind === 'ui' && (
            <>
              <button type="button" onClick={onEdit} aria-haspopup="dialog" className="grid size-9 shrink-0 place-items-center rounded-full text-ink-300" title="Edit this scorecard">
                <Pencil className="size-5" aria-hidden />
                <span className="sr-only">Edit</span>
              </button>
              <button type="button" onClick={removeCard} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-300" title="Remove this scorecard">
                <Trash2 className="size-5" aria-hidden />
                <span className="sr-only">Remove</span>
              </button>
            </>
          )}
        </PhoneBar>
      )}
      <header className="shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {!narrow && (
            <Link to={to(null)} className="btn btn-ghost mr-1 px-2 py-0.5 text-[12px] xl:hidden">
              <ArrowLeft className="size-3.5" aria-hidden /> Every scorecard
            </Link>
          )}
          {kinds.length === 1 ? (
            <KindChip id={kinds[0]!} blueprints={blueprints} />
          ) : (
            <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[12px] font-medium text-ink-200">
              <Layers className="size-3" aria-hidden />
              {plural(kinds.length, 'kind')}
            </span>
          )}
          {sc.origin.kind !== 'ui' && (
            <Badge className="border-ink-700 text-ink-400" title={sc.origin.kind === 'git' ? sc.origin.file : `Put by source ${sc.origin.source}, which keeps it`}>
              {sc.origin.kind === 'git' ? 'Git' : sc.origin.source}
            </Badge>
          )}
          {/* Below a large window the board is out of sight, so its lens rides with the card. */}
          <LensSwitch reader={reader} id={sc.id} className="ml-auto xl:hidden" />
        </div>
        <div className="mt-1.5 flex flex-wrap items-end gap-x-6 gap-y-3">
          <h1 className="min-w-0 flex-1 basis-64 font-serif text-[32px] leading-[1.05] tracking-[-0.01em] text-ink-50 md:text-[38px]">{sc.title}</h1>
          <Trend byDay={card.byDay} standing={reading.standing} trendless={!!card.trendless} />
          {canAuthor && sc.origin.kind === 'ui' && !narrow && (
            <div className="ml-auto flex gap-2">
              <Button onClick={onEdit} opens="dialog">
                <Pencil className="size-3.5" aria-hidden /> Edit
              </Button>
              <Button title="Remove this scorecard" onClick={removeCard}>
                <Trash2 className="size-3.5" aria-hidden />
                <span className="sr-only">Remove</span>
              </Button>
            </div>
          )}
        </div>
        <p className="mt-2 max-w-4xl text-[14px] leading-relaxed text-pretty text-ink-200">
          {reading.none ? `${reading.none.toLocaleString()} of ${plural(reading.scored, 'entity', 'entities')} reach no level` : `All ${plural(reading.scored, 'entity', 'entities')} reach a level`}
          {`, and ${reading.top.toLocaleString()} stand at the top.`}
          {lead && lead.lifts > 0 && (
            <>
              {' '}
              <button type="button" onClick={() => setFilter(onRule(lead.blueprint, lead.rule.id))} className="font-medium text-ink-50 underline decoration-ink-600 underline-offset-2 hover:decoration-ink-300" title="Show the entities that fail it">
                {lead.rule.title}
              </button>{' '}
              alone holds back {leadGroup!.lifts.toLocaleString()}
              {leadGroup!.parts.length > 1 ? ` across ${plural(leadGroup!.parts.length, 'kind')}` : kinds.length > 1 ? ` ${name(lead.blueprint)}` : ''} from {sc.levels[lead.level]!.name}.
            </>
          )}
        </p>
        {notYours && <p className="mt-1 max-w-4xl text-[13px] text-ink-300">Nothing of yours is scored here. This is how {reader.seesAll ? 'the estate' : 'what you can see'} stands.</p>}
        {sc.description && <p className="mt-1 max-w-4xl text-[13px] text-ink-400">{sc.description}</p>}
        {parts.some((p) => p.where) && (
          <p className="mt-1 text-[12px] text-ink-400" title="Only entities that match the scope are scored; the rest have no level and are in no count.">
            {scopeWords(parts, blueprints, name)}
            {out ? ` · ${out.toLocaleString()} out of scope` : ''}
          </p>
        )}
      </header>
      <ErrorNote error={remove.error} />
      <LadderBand card={card} picked={filter.stopsBefore} onPick={(level, blocker) => setFilter((f) => ({ ...f, show: 'all', stopsBefore: level, fails: blocker?.rule.id ?? null, kind: blocker?.blueprint ?? f.kind, search: '' }))} />
      {/* One panel: on a large window a column of the card's fixes and kinds beside the grid; below it, the kinds above the grid. What is picked there is what the grid shows. */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 desk:flex-1 lg:flex-row">
        {kinds.length > 1 && <Kinds card={card} blueprints={blueprints} kind={filter.kind} narrow={narrow} onKind={(kind, fails) => setFilter((f) => (fails ? onRule(kind, fails) : { ...f, kind, fails: null, stopsBefore: null, search: '' }))} />}
        {kinds.length > 1 && <Rail card={card} blueprints={blueprints} filter={filter} onRule={(kind, rule) => setFilter(onRule(kind, rule))} onKind={(kind) => setFilter((f) => ({ ...f, kind, fails: null, stopsBefore: null, search: '' }))} />}
        <Matrix card={card} filter={filter} setFilter={setFilter} blueprints={blueprints} narrow={narrow} joined />
      </div>
    </div>
  )
}

/** Each kind of a card, how its entities stand, weakest first. */
function kindsOf(card: Card) {
  const { sc, results } = card
  const tops = topsOf(sc)
  return blueprintsOf(sc)
    .map((k) => {
      const mine = results.rows.filter((r) => r.entity.blueprint === k)
      const counts = [-1, ...sc.levels.map((_, i) => i)].map((level) => mine.filter((r) => r.level === level).length)
      const blocker = card.lifts.find((l) => l.blueprint === k && l.lifts > 0) ?? null
      return { kind: k, total: mine.length, counts, standing: standing(sc, counts), top: mine.filter((r) => atTop(r, tops)).length, blocker }
    })
    .filter((k) => k.total)
    .sort((a, b) => a.standing - b.standing || b.total - a.total)
}

/**
 * Beside the grid on a large window, on a card over several kinds: the
 * card's fixes, most lifted first, each filtering the grid to those who fail
 * it; and every kind weakest first, each showing that kind in the grid. Both
 * lists scroll inside the column.
 */
function Rail({ card, blueprints, filter, onRule, onKind }: { card: Card; blueprints: Blueprint[]; filter: Filter; onRule: (kind: string, rule: string) => void; onKind: (kind: string) => void }) {
  const { sc } = card
  const name = useBlueprintName()
  const of = sc.levels.length
  const fixes = groupLifts(card.lifts)
  const kinds = kindsOf(card)
  // A rule several kinds hold shows its two largest; the rest open on asking.
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="hidden w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-850/40 lg:flex xl:w-64">
      <section aria-label="Fixes, most lifted first" className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 px-3 pt-2.5 pb-1.5 text-[13px] font-semibold text-ink-100">Fixes, most lifted first</h2>
        <ol className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
          {fixes.map((g) => {
            const lead = g.parts[0]!
            const on = g.parts.some((l) => filter.fails === l.rule.id && filter.kind === l.blueprint)
            return (
              <li key={`${g.level}:${g.title}`} className={`rounded-md px-1.5 py-1.5 ${on ? 'bg-ink-800 shadow-[inset_2px_0_0_var(--color-orbit)]' : ''}`}>
                <button type="button" aria-pressed={on} onClick={() => onRule(lead.blueprint, lead.rule.id)} className="w-full text-left hover:underline">
                  <span className="block text-[13px] leading-snug text-ink-100">{g.title}</span>
                  {lead.rule.fix && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-300">{lead.rule.fix}</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-400">
                    <span className="font-semibold text-ink-100 tabular-nums">+{g.lifts.toLocaleString()}</span>
                    <span aria-hidden>→</span>
                    <LevelPill name={sc.levels[g.level]!.name} index={g.level + 1} of={of} />
                  </span>
                </button>
                {g.parts.length > 1 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {(open === g.title ? g.parts : g.parts.slice(0, 2)).map((l) => (
                      <button key={l.blueprint} type="button" aria-pressed={filter.fails === l.rule.id && filter.kind === l.blueprint} onClick={() => onRule(l.blueprint, l.rule.id)} className={`${KIND_CHIP} ${filter.fails === l.rule.id && filter.kind === l.blueprint ? '!border-orbit !text-ink-50' : 'hover:border-ink-500'}`}>
                        {name(l.blueprint)} <span className="tabular-nums">+{l.lifts.toLocaleString()}</span>
                      </button>
                    ))}
                    {g.parts.length > 2 && open !== g.title && (
                      <button type="button" onClick={() => setOpen(g.title)} className={`${MORE_CHIP} hover:border-ink-400 hover:text-ink-100`}>
                        +{g.parts.length - 2} kinds
                      </button>
                    )}
                  </span>
                )}
                {g.parts.length === 1 && <span className="mt-0.5 block text-[12px] text-ink-400">{name(lead.blueprint)}</span>}
              </li>
            )
          })}
          {!fixes.length && <li className="px-1.5 py-2 text-[12px] text-ink-400">No one rule holds anything back alone.</li>}
        </ol>
      </section>
      {kinds.length > 0 && (
        <section aria-label="Kinds, weakest first" className="flex min-h-0 flex-1 flex-col border-t border-ink-700">
          <h2 className="flex shrink-0 items-baseline justify-between gap-2 px-3 pt-2.5 pb-1.5 text-[13px] font-semibold text-ink-100">
            {plural(kinds.length, 'kind')}, weakest first <span className="label">Standing</span>
          </h2>
          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
            {kinds.map((k) => {
              const on = k.kind === filter.kind
              return (
                <li key={k.kind}>
                  <button type="button" aria-pressed={on} onClick={() => onKind(k.kind)} className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 text-left ${on ? 'bg-ink-800 shadow-[inset_2px_0_0_var(--color-orbit)]' : 'hover:bg-ink-850'}`}>
                    <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-100">
                      <BlueprintIcon bp={blueprints.find((b) => b.id === k.kind)} className="size-3.5 shrink-0" />
                      <span className="min-w-0">{name(k.kind)}</span>
                      <span className="text-[12px] text-ink-400 tabular-nums">{k.total.toLocaleString()}</span>
                    </span>
                    <span className="text-[13px] font-semibold text-ink-50 tabular-nums">{Math.round(k.standing * 100)}</span>
                    <Ladder levels={sc.levels.map((l) => l.name)} counts={k.counts} track className="col-span-2 h-1.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

/** A kind the scorecard scores, by its icon and name, linking to its catalog. */
function KindChip({ id, blueprints }: { id: string; blueprints: Blueprint[] }) {
  const bp = blueprints.find((b) => b.id === id)
  const name = useBlueprintName()
  return (
    <Link to={{ page: 'inventory', blueprint: id }} className="inline-flex min-h-6 items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[12px] font-medium text-ink-200 hover:border-ink-500">
      <BlueprintIcon bp={bp} className="size-3" />
      {name(bp ?? id)}
    </Link>
  )
}

/**
 * Where the scorecard's entities stand, on one scale: a bar split by level,
 * no level first and the top last. Under each part, how many stand there
 * and, below the top, the rule that alone holds back the most of them from
 * the next level. Picking a part shows those entities in the grid.
 */
function LadderBand({ card, picked, onPick }: { card: Card; picked: number | null; onPick: (stopsBefore: number | null, blocker: Lift | null) => void }) {
  const { sc, reading } = card
  const name = useBlueprintName()
  const of = sc.levels.length
  const kinds = blueprintsOf(sc).length
  // The top first and no level last, as every bar on the page runs.
  const parts = [...sc.levels.map((_, i) => i)]
    .reverse()
    .concat(-1)
    .map((level) => ({ level, count: reading.counts[level + 1] ?? 0, name: level < 0 ? 'No level' : sc.levels[level]!.name }))
  // The bar is true to size; on a wide window the captions stand in equal columns beneath it, each joined to the middle of its piece by a leader line.
  const total = reading.scored || 1
  const mids = parts.reduce<{ at: number; mids: number[] }>((acc, p) => ({ at: acc.at + (p.count / total) * 100, mids: [...acc.mids, acc.at + (p.count / total) * 50] }), { at: 0, mids: [] }).mids
  const nobody = parts.filter((p) => !p.count).map((p) => p.name)
  const present = parts.filter((p) => p.count)
  const columns = `repeat(${present.length},minmax(0,1fr))`
  return (
    <section aria-label="Where the entities stand" className="shrink-0 rounded-xl border border-ink-700 bg-ink-900 px-4 pt-3.5 pb-2">
      <div className="flex h-3.5 gap-0.5 overflow-hidden rounded-[3px] bg-ink-800" role="img" aria-label={parts.map((p) => `${p.name}: ${p.count}`).join(', ')}>
        {parts.map((p) => (p.count ? <span key={p.level} className="block min-w-[3px]" style={{ flex: `${p.count} 0 0`, background: levelColor(p.level, of), backgroundImage: p.level < 0 ? HATCH : undefined }} title={`${p.name}: ${p.count.toLocaleString()}`} /> : null))}
      </div>
      {/* Each leader drops from the middle of its piece, steps across at its own height, and drops onto the start of its caption, so no two run together. */}
      <svg className="hidden h-4 w-full lg:block" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden>
        {present.map((p, i) => {
          const from = mids[parts.indexOf(p)]!
          const to = (i / present.length) * 100 + 1
          const across = 3 + (present.length > 1 ? (i / (present.length - 1)) * 8 : 4)
          return <path key={p.level} d={`M${from},0 V${across} H${to} V16`} fill="none" stroke="var(--color-edge)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        })}
      </svg>
      <ol className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 sm:grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] lg:mt-0 lg:[grid-template-columns:var(--parts)]" style={{ ['--parts' as string]: columns }}>
        {parts.map((p) => {
          const next = p.level + 1
          const top = next >= of
          const group = top ? undefined : groupLifts(card.lifts).find((g) => g.level === next)
          const blocker = top ? null : (group?.parts[0] ?? card.lifts.find((l) => l.level === next && l.failing > 0) ?? null)
          const on = picked === next && !top
          // The step that stops the most is the one to work on: it is marked so.
          const gap = !top && p.count > 0 && p.count === Math.max(...parts.filter((x) => x.level + 1 < of).map((x) => x.count))
          const head = (
            <span className="flex flex-col items-start gap-1">
              <span className="flex items-baseline gap-2">
                <span className="text-[18px] leading-none font-semibold text-ink-50 tabular-nums">{p.count.toLocaleString()}</span>
                <span className="text-[12px] text-ink-400 tabular-nums">{pct(p.count, reading.scored)}%</span>
              </span>
              {p.level < 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-300">
                  <span className="size-2 rounded-[2px]" style={{ background: levelColor(-1, of), backgroundImage: HATCH }} aria-hidden />
                  No level
                </span>
              ) : (
                <LevelPill name={p.name} index={p.level + 1} of={of} />
              )}
            </span>
          )
          return (
            <li key={p.level} className={`min-w-0 ${p.count ? '' : 'hidden'}`}>
              {top || !p.count ? (
                <div className="px-2 py-1.5">
                  {head}
                  <span className="mt-1 block text-[12px] leading-snug text-ink-400">{top ? 'At the top.' : `None stop before ${sc.levels[next]!.name}.`}</span>
                </div>
              ) : (
                <button type="button" aria-pressed={on} onClick={() => onPick(on ? null : next, on ? null : blocker)} title={`Show the ${p.count.toLocaleString()} that stop before ${sc.levels[next]!.name}`} className={`w-full rounded-md px-2 py-1.5 text-left text-pretty ${on ? 'bg-ink-800 ring-1 ring-orbit' : gap ? 'bg-red/5 ring-1 ring-red/40 hover:bg-red/10' : 'hover:bg-ink-850'}`}>
                  {gap && <span className="mb-1 block text-[12px] font-medium text-red">The biggest gap</span>}
                  {head}
                  <span className="mt-1 block text-[12px] leading-snug text-ink-300">
                    Before {sc.levels[next]!.name}:{' '}
                    {blocker && blocker.lifts > 0 ? (
                      <>
                        <span className={RULE}>{blocker.rule.title}</span> alone holds back {(group?.lifts ?? blocker.lifts).toLocaleString()}
                      </>
                    ) : blocker ? (
                      <>
                        most fail <span className={RULE}>{blocker.rule.title}</span>
                      </>
                    ) : (
                      'several rules each'
                    )}
                    {blocker && kinds > 1 && <span className="text-ink-400"> {group && group.parts.length > 1 ? `across ${plural(group.parts.length, 'kind')}` : `of ${name(blocker.blueprint)}`}</span>}.
                  </span>
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {/* With nothing at any level the verdict above already says so. */}
      {nobody.length > 0 && reading.none < reading.scored && <p className="mt-1.5 px-2 pb-1.5 text-[12px] text-ink-400">Nobody stands at {nobody.join(' or ')}.</p>}
    </section>
  )
}

/**
 * A scorecard over several kinds, every kind in view above the grid,
 * weakest first, one line each with its bar and standing. Picking one shows
 * it in the grid; under the box, the picked kind's blocker filters the grid
 * to those who fail it. A phone shows the weakest three until asked.
 */
function Kinds({ card, blueprints, kind, narrow, onKind }: { card: Card; blueprints: Blueprint[]; kind: string; narrow: boolean; onKind: (kind: string, fails?: string) => void }) {
  const { sc, results } = card
  const name = useBlueprintName()
  const [all, setAll] = useState(false)
  const rows = kindsOf(card)
  // A phone shows the weakest few until asked for the rest; elsewhere every kind is in view at once.
  const shown = narrow && !all ? rows.filter((k, i) => i < 3 || k.kind === kind) : rows
  const picked = rows.find((k) => k.kind === kind)
  return (
    <section aria-label="Kinds, weakest first" className="shrink-0 border-b border-ink-700 bg-ink-850/40 lg:hidden">
      <div className="flex items-baseline justify-between gap-3 px-3 pt-2.5 pb-1.5">
        <h2 className="text-[13px] font-semibold text-ink-100">{plural(rows.length, 'kind')}, weakest first</h2>
        <span className="label">Standing of 100</span>
      </div>
      <ul className="grid max-h-[9rem] grid-cols-1 gap-x-4 overflow-y-auto overscroll-contain px-1.5 sm:grid-cols-2 2xl:grid-cols-3">
        {shown.map((k) => {
          const on = k.kind === kind
          return (
            <li key={k.kind}>
              <button type="button" aria-pressed={on} onClick={() => onKind(k.kind)} title={`${name(k.kind)}: ${plural(k.total, 'entity', 'entities')}`} className={`grid min-h-7 w-full grid-cols-[minmax(0,1fr)_3.5rem_1.75rem] items-center gap-2 rounded-md px-1.5 text-left text-[13px] ${on ? 'bg-ink-800 text-ink-50 shadow-[inset_2px_0_0_var(--color-orbit)]' : 'text-ink-200 hover:bg-ink-850'}`}>
                <span className="flex min-w-0 items-center gap-2">
                  <BlueprintIcon bp={blueprints.find((b) => b.id === k.kind)} className="size-3.5 shrink-0" />
                  <span className="min-w-0">{name(k.kind)}</span>
                  <span className="text-[12px] text-ink-400 tabular-nums">{k.total.toLocaleString()}</span>
                </span>
                <Ladder levels={sc.levels.map((l) => l.name)} counts={k.counts} track className="h-1.5" />
                <span className="text-right font-semibold tabular-nums">{Math.round(k.standing * 100)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {shown.length < rows.length && (
        <button type="button" className="min-h-9 w-full px-3 text-left text-[13px] font-medium text-orbit" onClick={() => setAll(true)}>
          All {rows.length} kinds
        </button>
      )}
      {picked && (
        <p className="border-t border-ink-800 px-3 py-2 text-[12px] text-ink-400">
          <span className="font-medium text-ink-200">{name(picked.kind)}</span>
          {picked.blocker ? (
            <>
              {' '}
              · fix{' '}
              <button type="button" className={RULE} onClick={() => onKind(picked.kind, picked.blocker!.rule.id)}>
                {picked.blocker.rule.title}
              </button>
              : <span className="font-semibold text-ink-100 tabular-nums">+{picked.blocker.lifts.toLocaleString()}</span> up to {sc.levels[picked.blocker.level]!.name}
            </>
          ) : picked.top === picked.total ? (
            ' · all at the top.'
          ) : (
            ' · no one rule holds any back.'
          )}
        </p>
      )}
    </section>
  )
}

/** The standing now, and its line over the days kept. Plain SVG, no animation. */
function Trend({ byDay, standing, trendless }: { byDay: (number | null)[] | null; standing: number; trendless: boolean }) {
  const moved = byDay && movement(byDay)
  const w = 132
  const h = 44
  // The line fills its height over the range it moved in, at least ten points, so a small move still shows.
  const kept = (byDay ?? []).filter((v): v is number => v !== null)
  const lo = Math.min(...kept, standing)
  const span = Math.max(0.1, Math.max(...kept, standing) - lo)
  const points = (byDay ?? []).flatMap((v, i, all) => (v === null ? [] : [[(i / Math.max(1, all.length - 1)) * w, h - 4 - ((v - lo) / span) * (h - 8)] as const]))
  const path = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const last = points.at(-1)
  return (
    <div className="flex items-end gap-3">
      <div>
        <p className="label" title="How far up the ladder the entities stand on the whole: 0 when none reaches a level, 100 when all stand at the top.">
          Standing of 100
        </p>
        <p className="mt-1 flex items-baseline gap-2">
          <span className="text-[28px] leading-none font-semibold text-ink-50 tabular-nums">{Math.round(standing * 100)}</span>
          {!trendless && <Moved moved={moved ?? null} className="" />}
        </p>
      </div>
      {trendless ? null : points.length > 1 ? (
        <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-[132px]" role="img" aria-label={`Standing over the last ${byDay!.length} days`}>
          <line x1={0} x2={w} y1={h - 3} y2={h - 3} stroke="var(--color-grid)" />
          <path d={path} fill="none" stroke="var(--color-orbit)" strokeWidth={1.75} strokeLinejoin="round" />
          {last && <circle cx={last[0]} cy={last[1]} r={2.75} fill="var(--color-orbit)" />}
        </svg>
      ) : (
        <p className="w-[132px] text-[12px] text-ink-400">The trend fills in one day at a time.</p>
      )}
    </div>
  )
}

/** The narrowest the name column gets, the Fails column, and the narrowest a rule column, its title wrapped over three lines: in pixels. */
const NAME_MIN = 208
const FAILS = 52
const FLAT_RULE = 92

/** How many entities a phone shows before it is asked for more. */
const PHONE_ROWS = 10

/** The height of a row in the grid. Titles that wrap make a row taller; the grid measures each. */
const ROW = 36

/** One kind's entities against its rules, grouped under their levels. It scrolls both ways inside itself; the entity column and the headings stay. */
function Matrix({ card, filter, setFilter, blueprints, narrow, joined }: { card: Card; filter: Filter; setFilter: (f: Filter | ((f: Filter) => Filter)) => void; blueprints: Blueprint[]; narrow: boolean; joined: boolean }) {
  const { sc, results } = card
  const name = useBlueprintName()
  const of = sc.levels.length
  const tops = topsOf(sc)
  const kinds = blueprintsOf(sc)
  const bp = blueprints.find((b) => b.id === filter.kind)
  // Those who stop before a level pass every rule below it, so with a step picked the grid shows that level's rules only.
  const rules = rulesOf(sc).filter((r) => r.blueprint === filter.kind && (filter.stopsBefore === null || r.level === filter.stopsBefore))
  // A rule that reads one written field is mended by setting it: its failing mark opens that value.
  const mends = new Map(rules.map((r) => [r.rule.id, fixField(r.rule.where, bp)]))
  const ofKind = results.rows.filter((r) => r.entity.blueprint === filter.kind)
  const below = ofKind.filter((r) => !atTop(r, tops))
  const needle = filter.search.trim().toLowerCase()
  // With nothing below the top, the grid shows everything rather than nothing.
  const show = filter.show === 'below' && !below.length ? 'all' : filter.show
  const rows = (filter.stopsBefore !== null || show === 'all' ? ofKind : below)
    .filter((r) => filter.stopsBefore === null || r.level === filter.stopsBefore - 1)
    .filter((r) => !filter.fails || r.rules[filter.fails] === false)
    .filter((r) => !needle || r.title.toLowerCase().includes(needle))
    .sort((a, b) => a.level - b.level || failures(b) - failures(a) || a.title.localeCompare(b.title))
  // A rule is counted on the rows it applies to: one another judge leaves out of a row says nothing of it.
  const applying = (id: string) => ofKind.filter((r) => id in r.rules).length
  const passing = (id: string) => ofKind.filter((r) => r.rules[id] === true).length
  // A title several entities share is told apart by each one's key.
  const seen = new Map<string, number>()
  for (const r of ofKind) seen.set(r.title, (seen.get(r.title) ?? 0) + 1)
  const scroller = useRef<HTMLDivElement>(null)
  // On a phone the list ends in the page rather than scrolling inside it, a block at a time.
  const [phoneRows, setPhoneRows] = useState(PHONE_ROWS)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 16,
    // A row's height is kept by its entity, so a filter that brings a taller row to a place never borrows a shorter one's.
    getItemKey: (i) => rows[i]!.entity.key,
  })
  // A rule column is narrow; a level with few rules widens its columns so its name fits above them.
  const widths = rules.map((r) => {
    const group = rules.filter((x) => x.level === r.level).length
    return Math.max(48, Math.ceil((sc.levels[r.level]!.name.length * 7.5 + 40) / group))
  })
  // Rule titles lie flat and wrap; the rule columns share the width left over, and past their narrowest the grid scrolls sideways inside itself.
  const columns = `var(--name) ${FAILS}px ${widths.map((w) => `minmax(${Math.max(w, FLAT_RULE)}px,1fr)`).join(' ')}`
  const least = NAME_MIN + FAILS + widths.reduce((n, w) => n + Math.max(w, FLAT_RULE), 0)
  const groups = sc.levels
    .map((l, level) => ({
      name: l.name,
      level,
      count: rules.filter((r) => r.level === level).length,
    }))
    .filter((g) => g.count)
  const choices: { show: Filter['show']; label: string; count: number }[] = [
    { show: 'below', label: `Below the top · ${below.length.toLocaleString()}`, count: below.length },
    { show: 'all', label: `All · ${ofKind.length.toLocaleString()}`, count: ofKind.length },
  ]
  const switchClass = (on: boolean) => `min-h-7 rounded px-2.5 py-0.5 ${on ? 'bg-ink-700 text-ink-50' : 'text-ink-300 enabled:hover:text-ink-100 disabled:text-ink-500'}`
  const chip = (label: ReactNode, onClear: () => void) => (
    <span className="inline-flex items-center gap-1 rounded-full border border-orbit/60 bg-ink-850 py-0.5 pr-1 pl-2.5 text-[12px] text-ink-100">
      {label}
      <button type="button" className="grid size-6 place-items-center rounded-full text-ink-300 hover:bg-ink-700 hover:text-ink-50" onClick={onClear} aria-label="Clear this filter">
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
  return (
    <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${joined ? '' : 'rounded-xl border border-ink-700 bg-ink-900'} ${narrow ? '' : 'h-[70dvh] min-h-[22rem] desk:h-auto desk:min-h-[16rem]'}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-2">
        <h2 className="mr-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink-100">
          {kinds.length > 1 && <BlueprintIcon bp={bp} className="size-3.5 shrink-0" />}
          {kinds.length > 1 ? name(filter.kind) : 'Entities'}
          {kinds.length > 1 && (
            <span className="text-[12px] font-normal text-ink-400">
              · {plural(rules.length, 'rule')}
            </span>
          )}
        </h2>
        {filter.stopsBefore === null ? (
          <div role="group" aria-label="Which entities" className="flex rounded-md border border-ink-700 bg-ink-850 p-0.5 text-[12px] font-medium">
            {choices.map((o) => (
              <button key={o.show} type="button" aria-pressed={show === o.show} disabled={!o.count} onClick={() => setFilter((f) => ({ ...f, show: o.show }))} className={switchClass(show === o.show)}>
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          chip(<>Stop before {sc.levels[filter.stopsBefore]!.name}</>, () => setFilter((f) => ({ ...f, stopsBefore: null })))
        )}
        {filter.fails && chip(<>Fail {rules.find((r) => r.rule.id === filter.fails)?.rule.title ?? filter.fails}</>, () => setFilter((f) => ({ ...f, fails: null })))}
        {narrow && (
          <label className="min-w-0 flex-1 basis-full">
            <span className="sr-only">Show only those that fail a rule</span>
            <select className={`${input} w-full py-1 text-[13px]`} value={filter.fails ?? ''} onChange={(e) => setFilter((f) => ({ ...f, fails: e.target.value || null }))}>
              <option value="">Every rule</option>
              {rules.map((r) => (
                <option key={r.rule.id} value={r.rule.id}>
                  Fail {r.rule.title} · {sc.levels[r.level]!.name} · {applying(r.rule.id) ? Math.round((passing(r.rule.id) / applying(r.rule.id)) * 100) : 0}% pass
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="relative min-w-0 flex-1 basis-40 md:max-w-64 xl:ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-400" aria-hidden />
          <input type="search" className={`${input} w-full py-1 pl-8 text-[13px]`} placeholder={`Find among ${rows.length.toLocaleString()}`} aria-label="Find an entity by its title" value={filter.search} onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))} />
        </label>
      </div>
      {narrow ? (
        <div>
          <ul aria-label={`${name(filter.kind)} on ${sc.title}`}>
            {rows.slice(0, phoneRows).map((row) => {
              const failed = rules.filter((r) => row.rules[r.rule.id] === false)
              // What holds it where it is: the failing rules of the lowest level it fails, then a count of the rest.
              const stuck = failed.length ? Math.min(...failed.map((r) => r.level)) : -1
              const blocking = failed.filter((r) => r.level === stuck)
              return (
                <li key={row.entity.key} className="border-b border-ink-800 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={{ page: 'entity', ...row.entity }} className="flex min-h-6 min-w-0 flex-col justify-center text-[14px] font-medium [overflow-wrap:anywhere] text-ink-100">
                      {breakable(row.title)}
                      {(seen.get(row.title) ?? 0) > 1 && (
                        <span className="block font-mono text-[12px] font-normal [overflow-wrap:anywhere] text-ink-400" title={row.entity.key}>
                          {breakable(middle(row.entity.key, 34))}
                        </span>
                      )}
                    </Link>
                    <LevelPill name={row.level < 0 ? 'No level' : row.levelName} index={row.level + 1} of={of} />
                  </div>
                  <p className="mt-1 text-[12px] leading-snug text-ink-400">
                    {failed.length ? (
                      <>
                        Before {sc.levels[stuck]!.name}:{' '}
                        <span className="text-ink-200">
                          {blocking
                            .slice(0, 3)
                            .map((r) => r.rule.title)
                            .join(', ')}
                        </span>
                        {blocking.length > 3 && ` and ${blocking.length - 3} more`}
                        {failed.length > blocking.length && ` · ${(failed.length - blocking.length).toLocaleString()} more at higher levels`}
                      </>
                    ) : (
                      'Passes every rule.'
                    )}
                  </p>
                </li>
              )
            })}
          </ul>
          {rows.length > phoneRows && (
            <button type="button" className="min-h-11 w-full px-4 text-left text-[13px] font-medium text-orbit" onClick={() => setPhoneRows((n) => n + PHONE_ROWS)}>
              Show {Math.min(PHONE_ROWS, rows.length - phoneRows)} more of {rows.length.toLocaleString()}
            </button>
          )}
          {!rows.length && <p className="px-4 py-10 text-center text-sm text-ink-400">{ofKind.length ? 'Nothing here matches.' : 'Nothing to score.'}</p>}
        </div>
      ) : (
        <div ref={scroller} className={`min-h-0 flex-1 overflow-auto overscroll-contain [--name:13rem] 2xl:[--name:17rem]`} role="table" aria-label={`${name(filter.kind)} against the rules of ${sc.title}`} aria-rowcount={rows.length + 2}>
          <div style={{ width: `max(100%, ${least}px)` }}>
            <div role="rowgroup" className="sticky top-0 z-20 bg-ink-900">
              <div role="row" className="grid" style={{ gridTemplateColumns: columns }}>
                <span role="columnheader" className="sticky left-0 z-10 bg-ink-900" />
                <span role="columnheader" />
                {groups.map((g) => (
                  <span key={g.name} role="columnheader" className="flex items-end border-l border-ink-800 px-1.5 pt-2 pb-1.5" style={{ gridColumn: `span ${g.count}` }}>
                    <LevelPill name={g.name} index={g.level + 1} of={of} />
                  </span>
                ))}
              </div>
              <div role="row" className="grid border-b border-ink-700 text-[12px] text-ink-400" style={{ gridTemplateColumns: columns }}>
                <span role="columnheader" className="sticky left-0 z-10 flex flex-col items-start justify-end gap-0.5 bg-ink-900 px-4 pb-2">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-100">
                    <BlueprintIcon bp={bp} className="size-3.5 shrink-0" />
                    {name(filter.kind)}
                  </span>
                  <span className="font-normal">{plural(rows.length, 'entity', 'entities')} shown</span>
                </span>
                <span role="columnheader" className="flex items-end justify-end px-2 pb-2 font-medium" title="How many of these rules it fails">
                  Fails
                </span>
                {rules.map((r, i) => {
                  const share = applying(r.rule.id) ? passing(r.rule.id) / applying(r.rule.id) : 0
                  const on = filter.fails === r.rule.id
                  return (
                    <span key={r.rule.id} role="columnheader" className={i === 0 || rules[i - 1]!.level !== r.level ? 'border-l border-ink-800' : ''}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setFilter((f) => ({ ...f, fails: on ? null : r.rule.id }))}
                        title={`${r.rule.title}. ${r.rule.description ? `${r.rule.description} ` : ''}${Math.round(share * 100)}% pass. Show only those that fail it.`}
                        className={`flex h-full w-full flex-col items-start justify-end gap-1.5 px-2 pt-1 pb-2 hover:bg-ink-850 ${on ? 'bg-ink-800 text-ink-100 shadow-[inset_0_-2px_0_var(--color-orbit)]' : ''}`}
                      >
                        <span className="line-clamp-3 text-left leading-snug text-ink-200">{r.rule.title}</span>
                        <span className={`tabular-nums ${share >= 0.9 ? 'text-green' : share >= 0.5 ? 'text-amber' : 'text-red'}`}>{Math.round(share * 100)}%</span>
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
            <div role="rowgroup" className="relative" style={{ height: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index]!
                const failed = rules.filter((r) => row.rules[r.rule.id] === false).length
                const level = row.level < 0 ? 'No level' : row.levelName
                return (
                  <div key={row.entity.key} ref={virtual.measureElement} data-index={item.index} role="row" className="group absolute inset-x-0 grid border-b border-ink-800" style={{ gridTemplateColumns: columns, transform: `translateY(${item.start}px)` }}>
                    <span role="cell" className="sticky left-0 z-10 flex items-stretch gap-3 bg-ink-900 py-1 pr-3 pl-2 group-hover:bg-ink-850">
                      <span className="w-1 shrink-0 rounded-full" style={{ background: levelColor(row.level, of), backgroundImage: row.level < 0 ? HATCH : undefined }} title={level} aria-hidden />
                      <Link to={{ page: 'entity', ...row.entity }} className="flex min-h-6 min-w-0 flex-col justify-center text-[13px] font-medium [overflow-wrap:anywhere] text-ink-100 hover:underline">
                        <span>
                          {breakable(row.title)}
                          <span className="sr-only">, {level}</span>
                        </span>
                        {(seen.get(row.title) ?? 0) > 1 && (
                          <span className="font-mono text-[12px] font-normal whitespace-nowrap text-ink-400" title={row.entity.key}>
                            {/* The id tells repeated titles apart: as much of it as the column holds, cut in the middle. */}
                            <span className="2xl:hidden">{middle(row.entity.key, 24)}</span>
                            <span className="hidden 2xl:inline">{middle(row.entity.key, 32)}</span>
                          </span>
                        )}
                      </Link>
                    </span>
                    <span role="cell" className={`flex items-center justify-end px-2 text-[13px] tabular-nums group-hover:bg-ink-850 ${failed ? 'text-ink-100' : 'text-ink-400'}`}>
                      {failed || '–'}
                    </span>
                    {rules.map((r, i) => (
                      <span key={r.rule.id} role="cell" className={`flex items-center justify-center group-hover:bg-ink-850 ${i === 0 || rules[i - 1]!.level !== r.level ? 'border-l border-ink-800' : ''} ${filter.fails === r.rule.id ? 'bg-ink-850' : ''}`}>
                        {!(r.rule.id in row.rules) ? (
                          <span className="text-[12px] text-ink-500" aria-label="does not apply" role="img" title="Does not apply to it">
                            –
                          </span>
                        ) : row.rules[r.rule.id] === true ? (
                          <CircleCheck className="size-3.5 text-green" aria-label="passes" role="img" />
                        ) : row.rules[r.rule.id] === null ? (
                          <span title="Its judge had no data on it, which holds it below this level">
                            <CircleHelp className="size-3.5 text-ink-400" aria-label="no data" role="img" />
                          </span>
                        ) : bp && mends.get(r.rule.id) ? (
                          <FixMark entity={row.entity} title={row.title} bp={bp} field={mends.get(r.rule.id)!} />
                        ) : (
                          <CircleX className="size-4 text-red" aria-label="fails" role="img" />
                        )}
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>
            {!rows.length && <p className="sticky left-0 px-4 py-10 text-center text-sm text-ink-400">{ofKind.length ? 'Nothing here matches.' : 'Nothing to score.'}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

/** A name that may wrap after a / - _ or . rather than anywhere in a word: ids and paths have no spaces to wrap at. */
const breakable = (text: string): ReactNode[] =>
  text
    .split(/(?<=[/_.-])/)
    // A piece of one or two characters stays with the one before it, so a wrap never strands it.
    .reduce<string[]>((parts, part) => (parts.length && part.length < 3 ? [...parts.slice(0, -1), parts.at(-1)! + part] : [...parts, part]), [])
    .flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]))

const failures = (row: ScorecardRow) => Object.values(row.rules).filter((v) => v === false).length

/** A scorecard's own definition, as the editor shows it. */
const specOf = (sc: Scorecard) => {
  const { origin: _o, updatedAt: _u, ...spec } = sc
  return toYaml(spec)
}

const TEMPLATE = `id: repo_hygiene
blueprint: system
title: Repository hygiene
description: What a repository needs to be trusted.
levels:
  - name: Bronze
    rules:
      - id: has_repo
        title: Links to a repository
        where: { field: repo, op: exists }
  - name: Silver
    rules:
      - id: has_owner
        title: Has an owner
        where: { field: owner, op: exists }
`

function Editor({ initial, id, onDone }: { initial: string; id?: string; onDone: () => void }) {
  const save = useSaveScorecard()
  const blueprints = useBlueprints()
  const [text, setText] = useState(initial)
  useEscape(onDone, text !== initial)
  const [parseError, setParseError] = useState<string | null>(null)
  const submit = () => {
    try {
      const spec = parseYaml(text) as Record<string, unknown>
      setParseError(null)
      const target = (id ?? spec.id) as string
      save.mutate(
        { id: target, spec },
        {
          onSuccess: () => (onDone(), navigate({ page: 'scorecards', id: target })),
        },
      )
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Drawer title={id ? `Edit ${id}` : 'New scorecard'} subtitle="A scorecard in YAML" width={720} onClose={onDone}>
      <div className="flex flex-col gap-3">
        <textarea className={`${input} min-h-[50vh] w-full font-mono text-[12px]`} aria-label="The scorecard, in YAML" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <ErrorNote error={parseError ?? save.error} />
        <div className="flex gap-2">
          <Button kind="solid" onClick={submit} disabled={save.isPending}>
            Save
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
        <p className="text-[12px] leading-relaxed text-ink-400">
          A top-level where is the scope: only what matches it is scored. For several blueprints, give blueprints: {'{ storage: { where?, rules: { Bronze: [...], Silver: [...] } } }'} and levels with names only. Rules are search filters: {'{ field, op, value }'} with eq, neq, gt, gte, lt, lte, in, contains, prefix, exists, and within or older with a duration like 30d; {'{ relation: team }'} passes
          when the relation is set, {'{ relation: "<-api:service" }'} when something points here; combine with and, or, not. Blueprints: {blueprints.data?.blueprints.map((b) => b.id).join(', ')}
        </p>
      </div>
    </Drawer>
  )
}
