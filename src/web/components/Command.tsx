// The command bar: one box that finds any page, any kind, and any thing, from
// anywhere. ⌘K or Ctrl+K opens it, and so does the search control in the
// shell. It is a modal dialog with a combobox: arrow keys move through the
// results, Enter opens one, Escape closes it and gives focus back.

import { ArrowRight, CornerDownLeft, Search as SearchIcon } from 'lucide-react'
import { createContext, type ComponentType, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../layers.ts'
import type { StatusLevel } from '../../shared/model.ts'
import { useAlerts, useBlueprintName, useBlueprints, useMine, useSearch, useSummary } from '../api.ts'
import { alertsOn, levelOf, needsOf, perspectiveOf, yoursOf } from '../now.ts'
import { humanTimes } from '../format.ts'
import { useZen } from '../zen.ts'
import { BlueprintIcon, Icon } from '../icons.tsx'
import { navigate, type Route } from '../router.ts'
import { PAGE_TITLE } from '../title.ts'
import { useKeyboardLift } from './Popover.tsx'
import { Lamp, useNarrow } from './ui.tsx'

/** How close a title is to the words: it is them, starts with them, holds them, or only something else does. */
export function rank(title: string, words: string): number {
  const t = title.toLowerCase()
  return t === words ? 0 : t.startsWith(words) ? 1 : t.includes(words) ? 2 : 3
}

interface Hit {
  id: string
  section: string
  title: string
  /** A plain line under the title: where it belongs. */
  detail?: string
  /** An identifier under the title, set in mono. */
  code?: string
  /** A count at the row's end. */
  count?: number
  icon: ReactNode
  level?: StatusLevel
  to: Route
}

const NEEDS_YOU = 'Needs you'
const NEEDS_ATTENTION = 'Needs attention'

const Open = createContext<(open: boolean) => void>(() => {})

/** Opens the command bar from anywhere below the provider. */
export const useCommand = () => useContext(Open)

type Page = { page: Route['page']; to: Route; icon: ComponentType<{ className?: string }> }

export function CommandProvider({ pages, children }: { pages: Page[]; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((o) => !o)
      }
    }
    addEventListener('keydown', keys)
    return () => removeEventListener('keydown', keys)
  }, [])
  return (
    <Open.Provider value={setOpen}>
      {children}
      {open && <CommandBar pages={pages} onClose={() => setOpen(false)} />}
    </Open.Provider>
  )
}

function CommandBar({ pages, onClose }: { pages: Page[]; onClose: () => void }) {
  useEscape(onClose)
  const [query, setQuery] = useState('')
  const [asked, setAsked] = useState('')
  const [at, setAt] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  const list = useId()
  const sheet = useNarrow()
  const lift = useKeyboardLift(sheet)
  useEffect(() => {
    const t = setTimeout(() => setAsked(query.trim()), 150)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    box.current?.focus()
    return () => {
      root?.removeAttribute('inert')
      opener?.focus()
    }
  }, [])
  const blueprints = useBlueprints().data?.blueprints ?? []
  const name = useBlueprintName()
  const summary = useSummary().data
  // Zen mode leaves out what needs attention: the palette finds, and says nothing of health.
  const zen = useZen()
  const alerts = useAlerts().data?.alerts
  const mine = useMine().data
  const found = useSearch(asked)
  const words = query.trim().toLowerCase()
  const hits = useMemo<Hit[]>(() => {
    const go = pages.filter((p) => !words || PAGE_TITLE[p.page].toLowerCase().includes(words)).map((p) => ({ id: `page:${p.page}`, section: 'Go to', title: PAGE_TITLE[p.page], icon: <p.icon className="size-4" />, to: p.to }))
    const counted = new Map(summary?.blueprints.map((b) => [b.id, b]))
    // Asked nothing, the biggest kinds come first; asked something, the closest names.
    const kinds = blueprints
      .filter((b) => !words || name(b).toLowerCase().includes(words))
      .sort((a, b) => (words ? rank(name(a), words) - rank(name(b), words) : (counted.get(b.id)?.active ?? 0) - (counted.get(a.id)?.active ?? 0)))
      .slice(0, words ? 6 : 6)
      .map((b) => {
        const c = counted.get(b.id)
        return { id: `kind:${b.id}`, section: 'Kinds', title: name(b), detail: b.group, count: c?.active, level: c ? levelOf(c.notGreen) : undefined, icon: <BlueprintIcon bp={b} className="size-4" />, to: { page: 'inventory', blueprint: b.id } as Route }
      })
    // What needs the reader is what is theirs when the hub knows; else it is everything they see, and says so.
    const view = mine ? perspectiveOf(mine) : null
    const own = view?.whose === 'yours'
    const needing = own && mine ? needsOf(yoursOf(mine), alertsOn(alerts ?? []), false) : summary ? needsOf(summary, alerts ?? []) : []
    const section = own ? NEEDS_YOU : NEEDS_ATTENTION
    const needs: Hit[] = !words && !zen && summary && mine
      ? needing
          .filter((n) => n.entity || n.blueprint)
          .slice(0, 3)
          .map((n) => ({ id: `need:${n.kind}:${n.title}`, section, title: `${n.kind === 'kind' ? name(n.title) : n.title}${n.count > 1 && n.kind === 'alert' ? ` × ${n.count}` : ''}`, detail: n.kind === 'entity' && n.entity ? `${name(n.entity.blueprint)} · ${humanTimes(n.why)}` : humanTimes(n.why), level: n.level, icon: <Lamp level={n.level} />, to: (n.entity ? { page: 'entity', ...n.entity } : { page: 'inventory', blueprint: n.blueprint! }) as Route }))
      : []
    const byId = new Map(blueprints.map((b) => [b.id, b]))
    const things = asked
      ? [...(found.data?.entities ?? [])]
          .sort((a, b) => rank(a.title, asked.toLowerCase()) - rank(b.title, asked.toLowerCase()) || a.title.localeCompare(b.title))
          .slice(0, 30)
          .map((e) => ({ id: e.id, section: 'Things', title: e.title, detail: name(byId.get(e.blueprint) ?? e.blueprint), code: e.key, icon: <Icon name={e.icon ?? byId.get(e.blueprint)?.icon} className="size-4" />, level: e.status.level, to: { page: 'entity', blueprint: e.blueprint, key: e.key } as Route }))
      : []
    // Past the first three, one row goes to the rest on Now.
    const rest = !words && !zen && summary && mine ? needing.length - needs.length : 0
    const more: Hit[] = rest > 0 ? [{ id: 'need:more', section, title: `${rest} more that need ${own ? 'you' : 'attention'}`, icon: <ArrowRight className="size-4" />, to: { page: 'now' } }] : []
    // Kinds come before things: a kind is the wider answer, and its few rows stay in sight above the list of things.
    return [...needs, ...more, ...kinds, ...(words ? things : []), ...go.slice(0, words ? 4 : go.length)]
  }, [pages, words, blueprints, name, asked, found.data, summary, alerts, mine, zen])
  useEffect(() => {
    setAt(0)
  }, [words])
  const pick = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return
      onClose()
      // A jump is no step down from the page it was made on: it starts a path of its own.
      navigate(hit.to, { start: true })
    },
    [onClose],
  )
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const by = event.key === 'ArrowDown' ? 1 : -1
      setAt((i) => (i + by + hits.length) % Math.max(hits.length, 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(hits[at])
    } else if (event.key === 'Tab') event.preventDefault()
  }
  useEffect(() => {
    document.getElementById(`${list}-${at}`)?.scrollIntoView({ block: 'nearest' })
  }, [at, list])
  const sections = [...new Set(hits.map((h) => h.section))]
  return createPortal(
    <div className="fixed inset-0 z-50" onKeyDown={keys}>
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-[2px]" aria-hidden onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Find anything" className={`absolute flex flex-col overflow-hidden border border-ink-600 bg-ink-900 elevate-pop ${sheet ? 'inset-x-0 top-3 rounded-2xl mx-2' : 'top-[12vh] left-1/2 w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl'}`} style={{ maxHeight: sheet ? `calc(100dvh - ${lift}px - 24px)` : '70vh' }}>
        <div className="flex items-center gap-3 border-b border-ink-700 px-4">
          <SearchIcon className="size-5 shrink-0 text-ink-400" aria-hidden />
          <input
            ref={box}
            role="combobox"
            aria-expanded="true"
            aria-controls={list}
            aria-activedescendant={hits.length ? `${list}-${at}` : undefined}
            aria-autocomplete="list"
            aria-label="Find a page, a kind, or a thing"
            enterKeyHint="go"
            className="min-w-0 flex-1 bg-transparent py-4 text-[17px] text-ink-100 placeholder:text-ink-400 focus:outline-none"
            placeholder="Find a page, a kind, or a thing"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="hidden rounded-md border border-ink-600 px-1.5 font-mono text-[12px] text-ink-400 md:inline">esc</kbd>
        </div>
        <ul id={list} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2 pb-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]">
          {sections.map((section) => (
            <li key={section} role="presentation">
              <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-ink-400" aria-hidden>
                {section}
              </div>
              <ul role="presentation">
                {hits.map((h, i) =>
                  h.section !== section ? null : (
                    <li key={h.id} id={`${list}-${i}`} role="option" aria-selected={i === at} onMouseMove={() => setAt(i)} onClick={() => pick(h)} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 ${i === at ? 'bg-ink-800 text-ink-50' : 'text-ink-200'}`}>
                      <span className="grid size-5 shrink-0 place-items-center text-ink-300">{h.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-medium break-words">{h.title}</span>
                        {(h.detail || h.code) && (
                          <span className="flex min-w-0 items-baseline gap-2 text-[12px] text-ink-400">
                            {h.detail && <span className={h.code ? 'shrink-0' : 'min-w-0 truncate'}>{h.detail}</span>}
                            {h.code && <span className="min-w-0 truncate font-mono">{h.code}</span>}
                          </span>
                        )}
                      </span>
                      {h.level && h.level !== 'green' && h.section !== NEEDS_YOU && h.section !== NEEDS_ATTENTION && <Lamp level={h.level} calm />}
                      {h.count !== undefined && <span className="shrink-0 text-[12px] text-ink-400 tabular-nums">{h.count.toLocaleString('en-US')}</span>}
                      {i === at && <CornerDownLeft className="size-4 shrink-0 text-ink-400" aria-hidden />}
                    </li>
                  ),
                )}
              </ul>
            </li>
          ))}
          {words && asked && found.data && !hits.length && <li className="px-3 py-6 text-center text-sm text-ink-400">Nothing holds “{asked}”.</li>}
        </ul>
        <div role="status" className="sr-only">
          {hits.length} results
        </div>
        <div className="hidden items-center gap-4 border-t border-ink-700 px-4 py-2 text-[12px] text-ink-400 md:flex" aria-hidden>
          <span><kbd className="font-mono">↑ ↓</kbd> to move</span>
          <span><kbd className="font-mono">↵</kbd> to open</span>
          <span><kbd className="font-mono">esc</kbd> to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
