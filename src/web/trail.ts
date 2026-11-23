// The trail: every page this tab visited, in order, and where on it the
// person stands. It follows the browser's own history one step for one entry:
// each entry carries the id of its step (`history.state.trail`), so Back,
// Forward, a swipe, and a jump from the breadcrumb all move the same place on
// it, and a new visit after going back drops the steps ahead, as the browser
// does. The trail's addresses and names live for the tab in sessionStorage, so
// a reload keeps it.
//
// What a page shows on a step (its filter, its tab, how far it scrolled) is
// kept by step in memory alone (`useVisit`, `useScrollBackIn`): Back and Forward
// find a page as it was left, and a reload or a new visit starts it clean.

import { useEffect, useState, useSyncExternalStore, type RefObject, type UIEvent } from 'react'

export interface Step {
  id: string
  /** The address, path and query, with any hash. */
  href: string
  /** What the page says it shows, such as a run's title; null until it says, and then its page's name stands in. */
  name: string | null
  /**
   * A path starts here: the page was reached from the main menu or a jump,
   * or opened first, not by following a link inside a page. The breadcrumb
   * reaches back no further; Back and the whole trail still do.
   */
  start?: boolean
}

export interface Trail {
  steps: Step[]
  /** The step shown, an index into `steps`. */
  at: number
}

/** The most steps a tab keeps. One older than these is let go from the front. */
export const MOST_STEPS = 200

const KEY = 'orrery.trail'

/** A new visit: the steps ahead of the one shown are dropped, and the visit goes after it. */
export function pushed(trail: Trail, step: Step): Trail {
  const steps = [...trail.steps.slice(0, trail.at + 1), step]
  const cut = Math.max(0, steps.length - MOST_STEPS)
  return { steps: steps.slice(cut), at: steps.length - 1 - cut }
}

/** A visit that takes the place of the one shown, so Back skips it. */
export function replaced(trail: Trail, step: Step): Trail {
  if (!trail.steps.length) return { steps: [step], at: 0 }
  return { steps: trail.steps.map((s, i) => (i === trail.at ? step : s)), at: trail.at }
}

/** The browser moved to the entry carrying `id`: the trail stands there. Null when no step of the trail carries it. */
export function movedTo(trail: Trail, id: string): Trail | null {
  const at = trail.steps.findIndex((s) => s.id === id)
  return at < 0 ? null : { steps: trail.steps, at }
}

/** The shown step's name, as its page says it. */
export function named(trail: Trail, id: string, name: string | null): Trail {
  return { steps: trail.steps.map((s) => (s.id === id ? { ...s, name } : s)), at: trail.at }
}

/** An address without its hash: two steps on one address are one place, however far down it each one looked. */
export function placeOf(href: string): string {
  const i = href.indexOf('#')
  return i < 0 ? href : href.slice(0, i)
}

/**
 * The steps the breadcrumb shows before the one shown: the last `room` places
 * of the path that led here, back to the step it started on, each with how
 * many entries back it lies. Steps on the same place as the one after them
 * are one place, and the latest of them stands for it.
 */
export function cameFrom(trail: Trail, room: number): { step: Step; back: number }[] {
  const out: { step: Step; back: number }[] = []
  let after = trail.steps[trail.at]
  if (!after || after.start) return out
  for (let i = trail.at - 1; i >= 0 && out.length < room; i--) {
    const step = trail.steps[i]!
    if (placeOf(step.href) !== placeOf(after.href)) {
      out.unshift({ step, back: trail.at - i })
      after = step
    }
    if (step.start) break
  }
  return out
}

/**
 * The steps the whole trail lists, newest first, by index: steps on one place
 * one after another are one row, the latest standing for them, and the step
 * shown always has its row.
 */
export function listed(trail: Trail): number[] {
  const out: number[] = []
  for (let i = trail.steps.length - 1; i >= 0; i--) {
    const next = trail.steps[i + 1]
    if (i === trail.at || !next || placeOf(next.href) !== placeOf(trail.steps[i]!.href)) out.push(i)
  }
  return out
}

/** The place Back goes up to: the one before the shown one on its path, and how many entries back it lies. Null where the path starts. */
export function upFrom(trail: Trail): { step: Step; back: number } | null {
  return cameFrom(trail, 1)[0] ?? null
}

/** How many places before the shown one the breadcrumb has no room for. */
export function folded(trail: Trail, room: number): number {
  return Math.max(0, cameFrom(trail, Number.MAX_SAFE_INTEGER).length - room)
}

// The browser side: one trail for the tab, kept in step with its history.

let trail: Trail = { steps: [], at: -1 }
const listeners = new Set<() => void>()
/** What each step's page left on it, by step and by name: in memory alone. */
const views = new Map<string, Map<string, unknown>>()
/** How the shown step was reached: a new visit, or a move along the trail. */
let arrival: 'visit' | 'move' = 'visit'

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
const here = () => `${location.pathname}${location.search}${location.hash}`
const stamp = (): string | null => {
  const s: unknown = history.state
  return s && typeof s === 'object' && 'trail' in s && typeof s.trail === 'string' ? s.trail : null
}

function read(): Trail {
  try {
    const raw = sessionStorage.getItem(KEY)
    const kept = raw ? (JSON.parse(raw) as Trail) : null
    return kept && Array.isArray(kept.steps) && typeof kept.at === 'number' ? kept : { steps: [], at: -1 }
  } catch {
    return { steps: [], at: -1 }
  }
}

function set(next: Trail): void {
  trail = next
  try {
    sessionStorage.setItem(KEY, JSON.stringify(trail))
  } catch {
    // A tab that keeps nothing still walks its trail while it is open.
  }
  for (const listen of listeners) listen()
}

/** The name a step's scroll is kept under. It stands above everything that runs as the module loads: a const read before its own line throws. */
const SCROLL = 'scroll'

/** Notes how far the shown step's page had scrolled, before the trail leaves it. */
function leave(): void {
  const step = trail.steps[trail.at]
  if (step) keep(step.id, SCROLL, scrollY)
}

function keep(step: string, name: string, value: unknown): void {
  let view = views.get(step)
  if (!view) views.set(step, (view = new Map()))
  view.set(name, value)
}

/** The browser stands on an entry: the trail stands on its step, or takes the entry as a new visit when no step carries it. */
function arrive(): void {
  const id = stamp()
  const moved = id ? movedTo(trail, id) : null
  if (moved) {
    if (moved.at === trail.at) return
    leave()
    arrival = 'move'
    return set(moved)
  }
  // An entry the trail never stamped: the page as first opened, an address typed or followed from outside, or a link to a place on the page. Only the last goes on the path it is on.
  leave()
  arrival = 'visit'
  const shown = trail.steps[trail.at]
  const step: Step = { id: newId(), href: here(), name: null, start: !shown || placeOf(shown.href) !== placeOf(here()) }
  history.replaceState({ ...(history.state as object | null), trail: step.id }, '')
  set(trail.at < 0 ? { steps: [step], at: 0 } : pushed(trail, step))
}

if (typeof window !== 'undefined') {
  trail = read()
  // The trail puts each page back where it was left, so the browser does not guess.
  history.scrollRestoration = 'manual'
  arrive()
  // Added before any page listens, so the trail has moved by the time a page reads where it is.
  addEventListener('popstate', arrive)
}

/**
 * Goes to an address as a new visit, or in place of the step shown. `start`
 * begins a new path; a visit in place of a step keeps whether that one did.
 * The caller tells the page it moved.
 */
export function visit(url: string, { replace = false, start = false }: { replace?: boolean; start?: boolean } = {}): void {
  leave()
  arrival = 'visit'
  const step: Step = { id: newId(), href: url, name: null, start: start || (replace && !!trail.steps[trail.at]?.start) }
  if (replace) history.replaceState({ trail: step.id }, '', url)
  else history.pushState({ trail: step.id }, '', url)
  set(replace ? replaced(trail, step) : pushed(trail, step))
}

/** Moves along the trail: back with a negative count, forward with a positive one. */
export function go(by: number): void {
  if (by !== 0) history.go(by)
}

const subscribe = (listen: () => void) => (listeners.add(listen), () => void listeners.delete(listen))
const snapshot = () => trail
const shownId = () => trail.steps[trail.at]?.id ?? ''

const shownHref = () => trail.steps[trail.at]?.href ?? ''

/** The address of the step shown. The route is read from it, so a page and the step it stands on always move together. */
export function useShownHref(): string {
  return useSyncExternalStore(subscribe, shownHref, shownHref)
}

/** The id of the step shown, read again only when the trail moves to another: a step being named draws nothing again. */
function useStepId(): string {
  return useSyncExternalStore(subscribe, shownId, shownId)
}

/** The trail, read again whenever it moves. */
export function useTrail(): Trail {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The step shown. */
export function useStep(): Step | undefined {
  const t = useTrail()
  return t.steps[t.at]
}

/**
 * A page names what the shown step shows, such as a run's title or an
 * entity's, for the breadcrumb and the window's title. Undefined while it is
 * still loading leaves the name as it was.
 */
export function useHere(name: string | null | undefined): void {
  const id = useStepId()
  useEffect(() => {
    if (id && name !== undefined && trail.steps.find((s) => s.id === id)?.name !== name) set(named(trail, id, name))
  }, [id, name])
}

/**
 * State a page shows on this step, such as a filter or a tab: like
 * `useState`, but Back and Forward find it as it was left on each step, and a
 * new visit starts from `initial`. `name` is unique on the page; a page that
 * holds the same state for several things names each, such as by its id.
 */
export function useVisit<T>(name: string, initial: T | (() => T)): [T, (next: T | ((was: T) => T)) => void] {
  const id = useStepId()
  const start = (): T => {
    const view = views.get(id)
    if (view?.has(name)) return view.get(name) as T
    return typeof initial === 'function' ? (initial as () => T)() : initial
  }
  const [held, setHeld] = useState(() => ({ id, name, value: start() }))
  // A page that stays drawn while the trail moves, or that asks for another name, takes the value the step left there, or starts again.
  const current = held.id === id && held.name === name ? held : { id, name, value: start() }
  if (current !== held) setHeld(current)
  const change = (next: T | ((was: T) => T)) =>
    setHeld((was) => {
      const value = typeof next === 'function' ? (next as (was: T) => T)(was.value) : next
      keep(was.id, was.name, value)
      return { ...was, value }
    })
  return [current.value, change]
}


/** What scrolls: the window, or one element on the page. */
interface Scroller {
  at: () => { top: number; left: number }
  to: (top: number, left: number) => void
  /** What grows as what it shows loads in. */
  grows: Element
}

/**
 * Puts a scroller back at a place as what it shows loads in. It stops at the
 * place, after a few seconds, or as soon as the person scrolls themselves.
 * Returns how to stop it early.
 */
function scrollBack(box: Scroller, place: { top: number; left: number }): () => void {
  let done = false
  const stop = () => {
    done = true
    watch.disconnect()
    clearTimeout(timer)
    for (const e of HANDS) removeEventListener(e, stop)
  }
  const tryPlace = () => {
    if (done) return
    box.to(place.top, place.left)
    const now = box.at()
    if (Math.abs(now.top - place.top) < 2 && Math.abs(now.left - place.left) < 2) stop()
  }
  const watch = new ResizeObserver(tryPlace)
  watch.observe(box.grows)
  const timer = setTimeout(stop, 4000)
  for (const e of HANDS) addEventListener(e, stop, { passive: true })
  tryPlace()
  return stop
}

/** What a person does to scroll the page themselves. */
const HANDS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

/** Puts the page where it was on the step the trail moved back or forward to; a new visit starts at the top. */
export function useScrollBack(): void {
  const id = useStepId()
  useEffect(() => {
    if (!id) return
    const y = arrival === 'move' ? views.get(id)?.get(SCROLL) : 0
    if (typeof y !== 'number') return
    return scrollBack({ at: () => ({ top: scrollY, left: 0 }), to: (top) => scrollTo(0, top), grows: document.body }, { top: y, left: 0 })
  }, [id])
}

/**
 * Keeps how far an element that scrolls inside the page (a grid, a list) had
 * scrolled on each step, and puts it back there on the step the trail returns
 * to. Hand the element's `onScroll` the handler this gives back.
 */
export function useScrollBackIn(ref: RefObject<HTMLElement | null>, name: string): (event: UIEvent<HTMLElement>) => void {
  const id = useStepId()
  const key = `${SCROLL}:${name}`
  useEffect(() => {
    const el = ref.current
    const place = views.get(id)?.get(key) as { top: number; left: number } | undefined
    if (!el || !place) return
    return scrollBack({ at: () => ({ top: el.scrollTop, left: el.scrollLeft }), to: (top, left) => el.scrollTo(left, top), grows: el.firstElementChild ?? el }, place)
  }, [id, key]) // eslint-disable-line react-hooks/exhaustive-deps
  return (event) => keep(id, key, { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })
}
