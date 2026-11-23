import { Check, ChevronRight, Copy, Download } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { valueColor, type FieldDef, type Layer, type StatusLevel, type ValueColor } from '../../shared/model.ts'
import { href, onLinkClick, type Route } from '../router.ts'
import { useZen } from '../zen.ts'

export const LEVEL_TEXT: Record<StatusLevel, string> = { red: 'text-red', amber: 'text-amber', green: 'text-green', grey: 'text-ink-400' }
/** Each status's colour in a drawing. */
export const LEVEL_FILL: Record<StatusLevel, string> = { red: 'var(--color-signal-red)', amber: 'var(--color-signal-amber)', green: 'var(--color-signal-green)', grey: 'var(--color-grey)' }
/** What each status is called to a person who cannot see its colour. */
export const LEVEL_NAME: Record<StatusLevel, string> = { red: 'failing', amber: 'warning', green: 'healthy', grey: 'unknown' }
/** Each status has its own shape as well as its colour, so it reads without colour: a dot, a square, a diamond, a ring. */
const SHAPE: Record<StatusLevel, string> = { green: 'rounded-full', amber: 'rounded-[1px]', red: 'rotate-45 scale-[0.85] rounded-[1px]', grey: 'rounded-full' }
const FILL: Record<StatusLevel, string> = { green: 'lamp-signal-green', amber: 'lamp-signal-amber', red: 'lamp-signal-red', grey: 'border-[1.5px] border-grey' }
// A faint lamp is the same shape drawn as a dashed outline: no fill, no glow.
const FAINT: Record<StatusLevel, string> = { green: 'border-signal-green', amber: 'border-signal-amber', red: 'border-signal-red', grey: 'border-grey' }

/** A status lamp. `faint` draws it as a dashed outline, for a status a person does not need to act on from here, such as one inside hidden items. `calm` marks a lamp on a page a person browses: zen mode draws none of those. */
export function Lamp({ level, size = 'md', className = '', title, faint = false, calm = false }: { level: StatusLevel; size?: 'sm' | 'md' | 'lg'; className?: string; title?: string; faint?: boolean; calm?: boolean }) {
  const zen = useZen()
  if (calm && zen) return null
  const dims = size === 'sm' ? 'size-1.5' : size === 'lg' ? 'size-3.5' : 'size-2.5'
  const look = faint ? `border-[1.5px] border-dashed ${FAINT[level]}` : FILL[level]
  return <span role="img" aria-label={`Status: ${LEVEL_NAME[level]}`} className={`lamp inline-block shrink-0 ${dims} ${SHAPE[level]} ${look} ${className}`} title={title} />
}

/** A link to a page of the app. `current` marks the one a person is on. `label` names a link that shows no words, and `describedBy` is the id of what says more of it. `start` marks one in the main menu: it begins a new path for the breadcrumb. */
export function Link({ to, className = '', style, children, title, current, label, describedBy, start, tabIndex }: { to: Route; className?: string; style?: CSSProperties; children: ReactNode; title?: string; current?: boolean; label?: string; describedBy?: string; start?: boolean; /** -1 inside a widget the arrow keys move through, such as a grid. */ tabIndex?: number }) {
  return (
    <a href={href(to)} onClick={(event) => onLinkClick(event, { start })} className={className} style={style} title={title} tabIndex={tabIndex} aria-current={current ? 'page' : undefined} aria-label={label} aria-describedby={describedBy}>
      {children}
    </a>
  )
}

export function External({ href: url, title, className = '', children }: { href: string; /** Said on hover, such as the whole address behind a short name. */ title?: string; className?: string; children: ReactNode }) {
  return (
    <a href={url} title={title} target="_blank" rel="noreferrer" className={`hover:text-ink-100 hover:underline underline-offset-4 ${className}`}>
      {children}
    </a>
  )
}

export function Button({ children, onClick, kind = 'ghost', disabled, type = 'button', title, opens, pressed, className = '' }: { children: ReactNode; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; kind?: 'ghost' | 'solid' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; title?: string; /** The button opens a dialog. */ opens?: 'dialog'; /** The button turns something on and off: whether it is on. */ pressed?: boolean; className?: string }) {
  // Whole class names, so the stylesheet keeps each one.
  const look = { ghost: 'btn-ghost', solid: 'btn-solid', danger: 'btn-danger' }[kind]
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} aria-haspopup={opens} aria-pressed={pressed} className={`btn ${look} ${pressed ? 'border-ink-300 bg-ink-800 text-ink-50' : ''} ${className}`}>
      {children}
    </button>
  )
}

/** Copies a text, and says so for a moment. `what` says which one to a screen reader, where several sit together; `text` may be worked out only when asked for. */
/** Saves a text as a file of this name, from the page. */
export function DownloadButton({ text, file, what, className = '' }: { text: string | (() => string); file: string; what?: string; className?: string }) {
  const save = () => {
    const url = URL.createObjectURL(new Blob([typeof text === 'function' ? text() : text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <button type="button" onClick={save} className={`flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[12px] text-ink-300 hover:bg-ink-800 hover:text-ink-100 ${className}`}>
      <Download aria-hidden className="size-3.5" /> Download
      {what && <span className="sr-only"> {what}</span>}
    </button>
  )
}

export function CopyButton({ text, what, className = '' }: { text: string | (() => string); what?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () =>
    void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  return (
    <button type="button" onClick={copy} className={`flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[12px] text-ink-300 hover:bg-ink-800 hover:text-ink-100 ${className}`}>
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      <span aria-live="polite">
        {copied ? 'Copied' : 'Copy'}
        {what && <span className="sr-only"> {what}</span>}
      </span>
    </button>
  )
}

/** The small line over a page's title. A link in it is tall enough to tap. */
export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`label [&_a]:inline-block [&_a]:py-1 ${className}`}>{children}</div>
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-ink-700 bg-ink-900/70 ${className}`}>{children}</section>
}

/** A panel that starts closed and says in one line what it holds, for settings changed once in a while. */
export function Fold({ title, summary, children }: { title: string; summary?: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-ink-700 bg-ink-900/70">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 self-center text-ink-400 group-open:rotate-90" aria-hidden />
        <span className="font-semibold text-ink-100">{title}</span>
        {summary && <span className="text-[13px] text-ink-400">{summary}</span>}
      </summary>
      <div className="border-t border-ink-800">{children}</div>
    </details>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-ink-700 px-6 py-12 text-center text-sm text-ink-400">{children}</div>
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return <div role="alert" className="rounded-md border border-red-dim bg-red/5 px-3 py-2 text-sm text-red">{error instanceof Error ? error.message : String(error)}</div>
}

export const LAYER_LABEL: Record<Layer, string> = { default: 'default', inherited: 'inherited', ui: 'edited', rule: 'rule', pushed: 'pushed', override: 'override', git: 'git' }
export const LAYER_STYLE: Record<Layer, string> = {
  default: 'border-ink-700 text-ink-400',
  inherited: 'border-ink-700 text-ink-400',
  ui: 'border-orbit/50 text-orbit',
  rule: 'border-ink-600 text-ink-300',
  pushed: 'border-ink-600 text-ink-300',
  override: 'border-amber/60 text-amber',
  git: 'border-green/50 text-green',
}

export function Badge({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[12px] font-medium whitespace-nowrap ${className}`}>
      {children}
    </span>
  )
}

/** A value colour as CSS. */
export const swatch = (color: ValueColor) => `var(--color-v-${color})`

/** A value colour's chip: a tint of it behind its text, pulled toward the brightest ink so it reads in either theme. */
export const chipStyle = (c: string): CSSProperties => ({ background: `color-mix(in oklab, ${c} 16%, transparent)`, color: `color-mix(in oklab, ${c} var(--chip-ink), var(--color-ink-50))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 28%, transparent)` })

/** A short categorical value in the colour `valueColor` gives it, the same wherever it appears. `label` is what shows when it is not the value itself. */
export function Chip({ value, label = value, def }: { value: string; label?: string; def?: Pick<FieldDef, 'type' | 'values' | 'colors'> }) {
  const c = swatch(valueColor(def, value))
  return (
    <span className="inline-block max-w-full truncate rounded-full px-2 py-px align-middle text-[12px] font-medium" style={chipStyle(c)}>
      {label}
    </span>
  )
}

/**
 * A row of tabs over one panel. Arrow keys move between them and show the
 * one they land on. The panel is the caller's: a `TabPanel` with the same `id`.
 */
export function Tabs<T extends string>({ id, label, tabs, value, onChange }: { id: string; label: string; tabs: { id: T; label: ReactNode }[]; value: T; onChange: (tab: T) => void }) {
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!by) return
    event.preventDefault()
    const next = tabs[(tabs.findIndex((t) => t.id === value) + by + tabs.length) % tabs.length]!
    onChange(next.id)
    document.getElementById(`${id}-${next.id}`)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={keys} className="flex flex-wrap items-end gap-1">
      {tabs.map((t) => (
        <button key={t.id} id={`${id}-${t.id}`} type="button" role="tab" aria-selected={t.id === value} aria-controls={`${id}-panel`} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)} className={`-mb-px border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors ${t.id === value ? 'border-ink-100 text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function TabPanel({ id, value, className = '', children }: { id: string; value: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} className={className}>
      {children}
    </div>
  )
}

export const input = 'rounded-md border border-edge bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100 focus:border-ink-300'
export const mono = 'font-mono text-[12px]'

/** Below the `md` breakpoint: a phone, where the pages sit in a tab bar and the catalog shows cards. */
const NARROW = '(max-width: 767px)'
const narrowQuery = typeof matchMedia === 'function' ? matchMedia(NARROW) : null
const watchNarrow = (fn: () => void) => (narrowQuery?.addEventListener('change', fn), () => narrowQuery?.removeEventListener('change', fn))

/** True on a small screen. It changes when the window crosses the breakpoint. */
export function useNarrow(): boolean {
  return useSyncExternalStore(watchNarrow, () => narrowQuery?.matches ?? false)
}

/**
 * The time now, moving once a second while `ticking`, so a page that shows
 * how long something has run keeps counting between the hub's answers.
 * Still while not ticking: a page that shows nothing under way re-renders
 * for nothing.
 */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return ticking ? now : Date.now()
}

/** A window wide and tall enough that a page may fill it and scroll its parts inside: the `desk` variant in `styles.css`, which must match. */
const DESK = '(min-width: 80rem) and (min-height: 46rem)'
const deskQuery = typeof matchMedia === 'function' ? matchMedia(DESK) : null
const watchDesk = (fn: () => void) => (deskQuery?.addEventListener('change', fn), () => deskQuery?.removeEventListener('change', fn))

/** True on a window the `desk` variant applies to. It changes when the window crosses either edge. */
export function useDesk(): boolean {
  return useSyncExternalStore(watchDesk, () => deskQuery?.matches ?? false)
}

/**
 * How many things wait for the reader to decide, beside the link to where
 * they wait: a count, and a spoken name. Nothing when none do. In zen mode the
 * count is still there, in plain grey: it asks, it does not shout.
 */
export function WaitingBadge({ n, title }: { n: number; title: string }) {
  const zen = useZen()
  if (!n) return null
  return (
    <span className={`ml-1.5 rounded-full ${zen ? 'bg-ink-600 text-ink-100' : 'bg-amber text-ink-950'} px-1.5 align-[1px] text-[12px] leading-4 tracking-normal tabular-nums`} title={title}>
      {n}
      <span className="sr-only"> waiting for your approval</span>
    </span>
  )
}
