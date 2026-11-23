// The queries a person has open, one tab each, the way a log explorer keeps
// several at hand. They are what the page is doing right now, so they live in
// memory alone: they outlast a visit to another page, and a reload starts
// again from the address.

import { useSyncExternalStore } from 'react'
import type { QueryColumnSpec, QuerySource, QuerySpec, QueryView } from '../shared/api.ts'
import { editable, START_COLUMNS } from './query.ts'

/** A query as the page edits it: its name, who may open it, its home, its blueprints, its columns, and how its answer is shown. */
export interface Draft {
  title: string
  shared: boolean
  audience: string | null
  /** The entity it belongs to, by id, or null for none. */
  home: string | null
  /** It opens to the people who own its home. */
  homeShared: boolean
  sources: QuerySource[]
  columns: QueryColumnSpec[]
  view?: QueryView
}

export const blankDraft = (): Draft => ({ title: '', shared: false, audience: null, home: null, homeShared: false, sources: [], columns: editable(START_COLUMNS, []) })
export const specOf = (d: Draft): QuerySpec => ({ sources: d.sources, columns: d.columns, ...(d.view ? { view: d.view } : {}) })
/** What the hub reads for a draft: its sources and columns. A change to the view alone needs no new read. */
export const readOf = (d: Pick<Draft, 'sources' | 'columns'>): string => JSON.stringify({ sources: d.sources, columns: d.columns })
export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b)

/** One open query. */
export interface Tab {
  key: string
  /** The saved query it is, or null for one not saved yet. */
  id: string | null
  draft: Draft
  /** What it held when it was opened or last saved, so the page can say what changed. */
  kept: Draft
  /** Whether a saved query's own content has filled it yet. */
  loaded: boolean
  /** What the hub was last asked to read for it (`readOf`), or null before the first run. */
  ran: string | null
}

let tabs: Tab[] = []
let active: string | null = null
let made = 0
const listeners = new Set<() => void>()
let snapshot: { tabs: Tab[]; active: string | null } = { tabs, active }

function changed(): void {
  snapshot = { tabs, active }
  for (const l of listeners) l()
}

function fresh(id: string | null): Tab {
  made++
  return { key: `t${made}`, id, draft: blankDraft(), kept: blankDraft(), loaded: id === null, ran: null }
}

/** Whether a tab holds nothing a person would lose: not saved, and nothing picked. */
const untouched = (t: Tab): boolean => t.id === null && sameDraft(t.draft, blankDraft())

/**
 * The tab for the query an address names, opened if it is not: a saved query
 * already open is brought forward; otherwise it opens in the tab in front when
 * that holds nothing, or in a new one.
 */
export function openQuery(id: string | null): void {
  const front = tabs.find((t) => t.key === active)
  if (front && front.id === id) return
  const held = id === null ? null : tabs.find((t) => t.id === id)
  if (held) {
    active = held.key
  } else if (id === null && front && untouched(front)) {
    return
  } else if (front && untouched(front)) {
    const next = fresh(id)
    tabs = tabs.map((t) => (t.key === front.key ? next : t))
    active = next.key
  } else {
    const next = fresh(id)
    tabs = [...tabs, next]
    active = next.key
  }
  changed()
}

/** A new tab with nothing in it, in front. */
export function newTab(): Tab {
  const next = fresh(null)
  tabs = [...tabs, next]
  active = next.key
  changed()
  return next
}

/** Changes one tab. */
export function updateTab(key: string, patch: Partial<Omit<Tab, 'key'>>): void {
  tabs = tabs.map((t) => (t.key === key ? { ...t, ...patch } : t))
  changed()
}

/** Closes a tab; the one beside it comes forward. Returns the tab now in front, if any. */
export function closeTab(key: string): Tab | null {
  const at = tabs.findIndex((t) => t.key === key)
  if (at < 0) return tabs.find((t) => t.key === active) ?? null
  tabs = tabs.filter((t) => t.key !== key)
  if (active === key) active = (tabs[at] ?? tabs[at - 1])?.key ?? null
  changed()
  return tabs.find((t) => t.key === active) ?? null
}

/** Closes every tab that holds a saved query, as when it is removed. */
export function closeQuery(id: string): void {
  for (const t of tabs.filter((x) => x.id === id)) closeTab(t.key)
}

/** Brings a tab forward. */
export function showTab(key: string): void {
  if (active === key) return
  active = key
  changed()
}

/** The open tabs and the one in front, as they stand. */
export const tabsNow = (): { tabs: Tab[]; active: string | null } => snapshot

/** The open tabs and the one in front, kept up as they change. */
export function useTabs(): { tabs: Tab[]; active: string | null } {
  return useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, tabsNow)
}
