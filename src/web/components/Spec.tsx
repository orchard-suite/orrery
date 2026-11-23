// An OpenAPI or Swagger document read as a reference: what the API is, where
// it is served, and each operation, opened in place to its parameters, body,
// and responses.

import { ChevronDown, ChevronRight, Lock } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FieldDef } from '../../shared/model.ts'
import { ago } from '../format.ts'
import { changesOf, exampleFor, isSpec, preferred, readView, requestOf, shapeOf, type SpecAuth, type SpecContent, type SpecOperation, type SpecParameter } from '../spec.ts'
import { Badge, Chip, Kicker, Panel, useNarrow } from './ui.tsx'

/** Each method's colour, and each status class's: what a reader of API references expects. */
const METHOD: Pick<FieldDef, 'type' | 'colors'> = { type: 'enum', colors: { GET: 'blue', POST: 'green', PUT: 'orange', PATCH: 'purple', DELETE: 'red', HEAD: 'grey', OPTIONS: 'grey', TRACE: 'grey' } }
const STATUS: Pick<FieldDef, 'type' | 'colors'> = { type: 'enum', colors: { '1': 'grey', '2': 'green', '3': 'blue', '4': 'orange', '5': 'red', d: 'grey' } }

/** How many operations a document holds before the panel offers a search. */
const FIND_FROM = 8
/** How many before it lists its groups beside them, on a screen wide enough. */
const OUTLINE_FROM = 40

/** The page address of one operation: `#<field>:<METHOD> <path>`, which opens it when the page loads. */
const anchorOf = (field: string, id: string) => `${field}:${id}`
const domId = (field: string, id: string) => `spec-${field}-${id.replace(/[^A-Za-z0-9]+/g, '-')}`

/**
 * Scrolls the box a page scrolls in until the element sits at its top. The
 * browser's own `scrollIntoView` also moves boxes that clip without
 * scrolling, which shifts the whole frame of the page.
 */
function bringIntoView(el: HTMLElement | null) {
  let box = el?.parentElement
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  if (!el) return
  const scroller = box ?? document.scrollingElement
  if (!scroller) return
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
  scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - top - 16, behavior: 'smooth' })
}

/** Copies text, and says which copy just landed for a moment. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (key: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(null), 1500)
    })
  return { copied, copy }
}
type Copier = ReturnType<typeof useCopy>

function CopyButton({ label, what, text, copier, className = '' }: { label: string; what: string; text: string; copier: Copier; className?: string }) {
  const done = copier.copied === what
  return (
    <button type="button" className={`btn btn-ghost shrink-0 px-2 py-0.5 ${className}`} onClick={() => copier.copy(what, text)}>
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  )
}

/**
 * An `openapi` field's document read in place. `previous` is the document
 * a push replaced, when the hub kept it: what changed between the two is
 * said at the top and marked on each operation.
 */
export function SpecPanel({ field, title, doc, previous, changedAt }: { field: string; title: string; doc: unknown; previous?: unknown; changedAt?: string | null }) {
  const view = useMemo(() => readView(doc as Parameters<typeof readView>[0]), [doc])
  const changes = useMemo(() => (isSpec(previous) && isSpec(doc) ? changesOf(previous, doc) : undefined), [previous, doc])
  const [server, setServer] = useState(0)
  const [query, setQuery] = useState('')
  const [raw, setRaw] = useState(false)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [showChanges, setShowChanges] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const narrow = useNarrow()
  const copier = useCopy()
  const serverId = useId()
  const count = view.groups.reduce((n, g) => n + g.operations.length, 0)
  const q = query.trim().toLowerCase()
  const groups = view.groups.map((g) => ({ ...g, operations: q ? g.operations.filter((o) => `${o.id} ${o.summary ?? ''}`.toLowerCase().includes(q)) : g.operations })).filter((g) => g.operations.length)
  const flip = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }
  const added = new Set(changes?.added)
  const changed = new Set(changes?.changed)
  const moved = !!changes && (changes.added.length > 0 || changes.removed.length > 0 || changes.changed.length > 0 || !!changes.version)

  /** Opens one operation, and its group, and brings it into view. */
  const reveal = (id: string) => {
    const group = view.groups.find((g) => g.operations.some((o) => o.id === id))
    if (!group) return
    setRaw(false)
    setQuery('')
    setClosed((c) => new Set([...c].filter((t) => t !== group.tag)))
    setOpened((o) => new Set(o).add(id))
    requestAnimationFrame(() => bringIntoView(document.getElementById(domId(field, id))))
  }
  const revealGroup = (tag: string) => {
    setCurrent(tag)
    setQuery('')
    setClosed((c) => new Set([...c].filter((t) => t !== tag)))
    requestAnimationFrame(() => bringIntoView(document.getElementById(domId(field, `group ${tag}`))))
  }
  // A link to one operation opens it, when the page loads and when the link changes on an open page.
  useEffect(() => {
    const follow = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1))
      if (hash.startsWith(`${field}:`)) reveal(hash.slice(field.length + 1))
    }
    follow()
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [field, view])

  const outline = count >= OUTLINE_FROM && !narrow
  const signIn = view.auth.guarded === 0 ? null : `${view.auth.labels.join(', or ')}, on ${view.auth.guarded === count ? 'every operation' : `${view.auth.guarded} of ${count} operations`}`
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-2">
        <Kicker>{title}</Kicker>
        <CopyButton label="Copy spec" what="spec" text={JSON.stringify(doc, null, 2)} copier={copier} className="ml-auto" />
        <button type="button" className="btn btn-ghost px-2 py-0.5" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? 'Show operations' : 'Show JSON'}
        </button>
      </div>
      {raw ? (
        <pre tabIndex={0} aria-label="The document as JSON" className="max-h-[70vh] overflow-auto px-4 py-3 font-mono text-[12px] text-ink-300">
          {JSON.stringify(doc, null, 2)}
        </pre>
      ) : (
        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-medium text-ink-100">{view.title}</h2>
              {view.version && <Badge className="border-ink-600 text-ink-300">{view.version}</Badge>}
              <Badge className="border-ink-600 text-ink-300">{view.standard}</Badge>
            </div>
            {view.description && <p className="mt-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-300">{view.description}</p>}
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            {view.servers.length > 0 && (
              <div className="min-w-0">
                <label htmlFor={serverId} className="label block pb-1">
                  Server
                </label>
                {view.servers.length === 1 ? (
                  <output id={serverId} className="block font-mono text-[12px] break-all text-ink-200">
                    {view.servers[0]}
                  </output>
                ) : (
                  <select id={serverId} className="max-w-full rounded-md border border-edge bg-ink-900 px-2 py-1 font-mono text-[12px] text-ink-100" value={server} onChange={(e) => setServer(Number(e.target.value))}>
                    {view.servers.map((url, i) => (
                      <option key={url} value={i}>
                        {url}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <div className="min-w-0">
              <div className="label pb-1">Sign-in</div>
              <div className="flex items-center gap-1.5 text-[13px] text-ink-200">
                {signIn ? (
                  <>
                    <Lock className="size-3.5 shrink-0 text-ink-400" aria-hidden />
                    {signIn}
                  </>
                ) : (
                  'None the document names'
                )}
              </div>
            </div>
            {count >= FIND_FROM && <input type="search" aria-label="Find an operation" placeholder={`Find in ${count} operations`} className="ml-auto w-full rounded-md border border-edge bg-ink-900 px-2 py-1 text-sm md:w-64" value={query} onChange={(e) => setQuery(e.target.value)} />}
          </div>
          {moved && changes && (
            <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-ink-100">
                  Changed{changedAt ? ` ${ago(changedAt)}` : ''}:{' '}
                  {[
                    changes.version && <span key="version">version {changes.version.from ?? 'none'} → {changes.version.to ?? 'none'}</span>,
                    changes.added.length > 0 && <span key="added" className="text-green">{changes.added.length} added</span>,
                    changes.removed.length > 0 && <span key="removed" className="text-red">{changes.removed.length} removed</span>,
                    changes.changed.length > 0 && <span key="changed" className="text-amber">{changes.changed.length} changed</span>,
                  ]
                    .filter(Boolean)
                    .flatMap((part, i) => (i ? [', ', part] : [part]))}
                </span>
                {(changes.added.length > 0 || changes.removed.length > 0 || changes.changed.length > 0) && (
                  <button type="button" className="btn btn-ghost ml-auto px-2 py-0.5" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
                    {showChanges ? 'Hide what changed' : 'See what changed'}
                  </button>
                )}
              </div>
              {showChanges && (
                <ul className="mt-2">
                  {[...changes.added.map((id) => ['added', id] as const), ...changes.changed.map((id) => ['changed', id] as const), ...changes.removed.map((id) => ['removed', id] as const)].map(([how, id]) => (
                    <li key={`${how} ${id}`} className="flex min-h-6 items-baseline gap-2">
                      <span className={`w-16 shrink-0 text-[12px] ${how === 'added' ? 'text-green' : how === 'removed' ? 'text-red' : 'text-amber'}`}>{how}</span>
                      {how === 'removed' ? (
                        <span className="font-mono text-[12px] break-all text-ink-400 line-through">{id}</span>
                      ) : (
                        <button type="button" className="min-h-6 text-left font-mono text-[12px] break-all text-ink-100 hover:underline" onClick={() => reveal(id)}>
                          {id}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {count === 0 && <p className="text-sm text-ink-400">The document lists no operations.</p>}
          {count > 0 && groups.length === 0 && <p className="text-sm text-ink-400">No operation matches “{query}”.</p>}
          <div className={outline ? 'grid grid-cols-[11rem_minmax(0,1fr)] items-start gap-4' : ''}>
            {outline && (
              <nav aria-label="Groups" className="sticky top-4 border-r border-ink-800 pr-2">
                <Kicker className="pb-1.5">Groups</Kicker>
                <ul>
                  {view.groups.map((g) => (
                    <li key={g.tag}>
                      <button
                        type="button"
                        aria-current={current === g.tag || undefined}
                        onClick={() => revealGroup(g.tag)}
                        className={`flex w-full items-baseline justify-between gap-2 rounded-sm border-l-2 px-2 py-1 text-left text-[13px] hover:bg-ink-850 ${current === g.tag ? 'border-orbit bg-ink-850 text-ink-100' : 'border-transparent text-ink-300'}`}
                      >
                        <span className="truncate">{g.tag}</span>
                        <span className="text-[12px] text-ink-400">{g.operations.length}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            <div className="min-w-0 space-y-4">
              {groups.map((g) => {
                const open = !closed.has(g.tag) || !!q
                return (
                  <section key={g.tag} id={domId(field, `group ${g.tag}`)} aria-label={g.tag} className="scroll-mt-4">
                    <button type="button" aria-expanded={open} onClick={() => setClosed(flip(closed, g.tag))} className="flex w-full items-baseline gap-2 py-1 text-left">
                      {open ? <ChevronDown className="size-3.5 self-center text-ink-400" aria-hidden /> : <ChevronRight className="size-3.5 self-center text-ink-400" aria-hidden />}
                      <span className="font-medium text-ink-100">{g.tag}</span>
                      <span className="text-[12px] text-ink-400">{g.operations.length}</span>
                      {g.description && <span className="truncate text-[13px] text-ink-400">{g.description}</span>}
                    </button>
                    {open && (
                      <ul className="mt-1 divide-y divide-ink-800 overflow-hidden rounded-md border border-ink-700">
                        {g.operations.map((o) => (
                          <Operation
                            key={o.id}
                            field={field}
                            op={o}
                            doc={doc}
                            server={view.servers[server]}
                            open={opened.has(o.id)}
                            onToggle={() => setOpened(flip(opened, o.id))}
                            mark={added.has(o.id) ? 'new' : changed.has(o.id) ? 'changed' : undefined}
                            guardedElsewhere={view.auth.guarded > 0}
                            copier={copier}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </Panel>
  )
}

function Method({ method }: { method: string }) {
  return (
    <span className="inline-flex w-16 shrink-0 justify-center font-mono">
      <Chip value={method.toUpperCase()} def={METHOD} />
    </span>
  )
}

/** The ways to sign in, said as a sentence: each way's schemes joined by "and", the ways by "or". */
function authText(ways: SpecAuth[][]): string {
  return ways.map((way) => way.map((a) => `${a.label}${a.scopes.length ? ` (scope ${a.scopes.join(', ')})` : ''}`).join(' and ')).join(', or ')
}

function Operation({ field, op, doc, server, open, onToggle, mark, guardedElsewhere, copier }: { field: string; op: SpecOperation; doc: unknown; server: string | undefined; open: boolean; onToggle: () => void; mark?: 'new' | 'changed'; guardedElsewhere: boolean; copier: Copier }) {
  const detail = useId()
  const url = `${(server ?? '').replace(/\/$/, '')}${op.path}`
  const link = () => `${window.location.origin}${window.location.pathname}${window.location.search}#${encodeURIComponent(anchorOf(field, op.id))}`
  return (
    <li id={domId(field, op.id)} className="scroll-mt-4">
      <button type="button" aria-expanded={open} aria-controls={detail} onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ink-850 max-md:flex-wrap max-md:gap-y-1">
        <Method method={op.method} />
        <span className={`min-w-0 font-mono text-[13px] break-all text-ink-100 ${op.deprecated ? 'line-through' : ''}`}>{op.path}</span>
        {op.summary && <span className="min-w-0 truncate text-[13px] text-ink-400 max-md:order-last max-md:w-full max-md:whitespace-normal">{op.summary}</span>}
        {op.deprecated && <Badge className="border-amber/60 text-amber">deprecated</Badge>}
        {mark === 'new' && <Badge className="border-green/60 text-green">new</Badge>}
        {mark === 'changed' && <Badge className="border-amber/60 text-amber">changed</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {op.auth.length > 0 && (
            <span title={`Needs ${authText(op.auth)}`}>
              <Lock className="size-3.5 text-ink-400" aria-hidden />
              <span className="sr-only">Needs sign-in</span>
            </span>
          )}
          <ChevronDown className={`size-4 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>
      {open && (
        <div id={detail} className="space-y-4 border-t border-ink-800 bg-ink-950/40 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 font-mono text-[12px] break-all text-ink-300">
              <span className="text-ink-400">{op.method.toUpperCase()}</span> {url}
            </span>
            {server && <CopyButton label="Copy URL" what={`url ${op.id}`} text={url} copier={copier} />}
            <CopyButton label="Copy link" what={`link ${op.id}`} text={link()} copier={copier} />
          </div>
          {op.auth.length > 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-ink-200">
              <Lock className="size-3.5 shrink-0 text-ink-400" aria-hidden />
              Needs {authText(op.auth)}.
            </p>
          ) : (
            guardedElsewhere && <p className="text-[13px] text-ink-300">Open: it needs no sign-in.</p>
          )}
          {op.description && <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-200">{op.description}</p>}
          {op.parameters.length > 0 && (
            <Part title="Parameters">
              <ul className="divide-y divide-ink-800">
                {op.parameters.map((p) => (
                  <Parameter key={`${p.in}:${p.name}`} p={p} doc={doc} />
                ))}
              </ul>
            </Part>
          )}
          {op.body && (
            <Part title={op.body.required ? 'Request body · required' : 'Request body'}>
              {op.body.description && <p className="pb-2 text-[13px] text-ink-300">{op.body.description}</p>}
              <Contents contents={op.body.contents} doc={doc} />
            </Part>
          )}
          <Examples op={op} doc={doc} server={server} copier={copier} />
          <Part title="Responses">
            {op.responses.length === 0 && <p className="text-[13px] text-ink-400">None listed.</p>}
            <ul className="space-y-3">
              {op.responses.map((r) => (
                <li key={r.code}>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono">
                      <Chip value={r.code[0] ?? 'd'} label={r.code} def={STATUS} />
                    </span>
                    <span className="text-[13px] text-ink-200">{r.description ?? ''}</span>
                  </div>
                  {r.contents.length > 0 && (
                    <div className="mt-2 pl-2">
                      <Contents contents={r.contents} doc={doc} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Part>
        </div>
      )}
    </li>
  )
}

const LANGUAGES = [
  ['curl', 'curl'],
  ['powershell', 'PowerShell'],
] as const

/** The request, ready to paste, beside an example of each response that has a body. */
function Examples({ op, doc, server, copier }: { op: SpecOperation; doc: unknown; server: string | undefined; copier: Copier }) {
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number][0]>('curl')
  const request = useMemo(() => requestOf(doc, op, server), [doc, op, server])
  const bodies = op.responses.flatMap((r) => {
    const content = preferred(r.contents)
    return content ? [{ code: r.code, description: r.description, content }] : []
  })
  const [code, setCode] = useState(bodies[0]?.code)
  const shown = bodies.find((b) => b.code === code) ?? bodies[0]
  return (
    <Part title="Examples">
      <div className="grid gap-3">
        <Pane
          label="Request"
          tabs={LANGUAGES.map(([id, name]) => ({ id, name, on: language === id, pick: () => setLanguage(id) }))}
          aside={<CopyButton label="Copy" what={`${language} ${op.id}`} text={request[language]} copier={copier} />}
          text={request[language]}
        />
        {shown && (
          <ResponsePane
            key={shown.code}
            doc={doc}
            content={shown.content}
            tabs={bodies.map((b) => ({ id: b.code, name: <Chip value={b.code[0] ?? 'd'} label={b.code} def={STATUS} />, on: b.code === shown.code, pick: () => setCode(b.code), title: b.description }))}
          />
        )}
      </div>
    </Part>
  )
}

function ResponsePane({ doc, content, tabs }: { doc: unknown; content: SpecContent; tabs: Tab[] }) {
  const { value, given } = useMemo(() => exampleFor(doc, content), [doc, content])
  return <Pane label="Example response" tabs={tabs} aside={<span className="text-[12px] text-ink-400">{given ? 'from the document' : 'made from the schema'}</span>} text={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} />
}

interface Tab {
  id: string
  name: React.ReactNode
  on: boolean
  pick: () => void
  title?: string
}

/** A block of text to read or copy, with buttons above it that choose which one. */
function Pane({ label, tabs, aside, text }: { label: string; tabs: Tab[]; aside: React.ReactNode; text: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-ink-700">
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 border-b border-ink-800 bg-ink-900 px-2 py-1">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-pressed={t.on} title={t.title} onClick={t.pick} className={`rounded-sm px-2 py-0.5 font-mono text-[12px] ${t.on ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
            {t.name}
          </button>
        ))}
        <span className="ml-auto">{aside}</span>
      </div>
      {/* It scrolls, so the keyboard can reach it. */}
      <pre tabIndex={0} aria-label={label} className="max-h-80 overflow-auto bg-ink-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-200">
        {text}
      </pre>
    </div>
  )
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Kicker className="pb-1.5">{title}</Kicker>
      {children}
    </div>
  )
}

function Parameter({ p, doc }: { p: SpecParameter; doc: unknown }) {
  const shape = shapeOf(doc, p.schema)
  return (
    <li className="grid gap-x-4 gap-y-0.5 py-1.5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <span className="font-mono text-[13px] break-all text-ink-100">{p.name}</span>
        {p.required && <span className="ml-1.5 text-[12px] text-amber">required</span>}
        <div className="font-mono text-[12px] text-ink-400">
          {p.in} · {shape.label}
          {shape.nullable && ' | null'}
        </div>
      </div>
      <div className="text-[13px] text-ink-300">
        {p.description ?? shape.description}
        {shape.values && <Values values={shape.values} />}
      </div>
    </li>
  )
}

/** A body's media types, each with its schema. */
function Contents({ contents, doc }: { contents: SpecContent[]; doc: unknown }) {
  // The same schema under several media types is drawn once, under all their names.
  const drawn = [...Map.groupBy(contents, (c) => JSON.stringify(c.schema ?? null)).values()]
  return (
    <div className="space-y-2">
      {drawn.map((same) => (
        <div key={same[0]!.type}>
          <div className="font-mono text-[12px] text-ink-400">{same.map((c) => c.type).join(', ')}</div>
          {same[0]!.schema !== undefined && <Schema doc={doc} schema={same[0]!.schema} seen={[]} />}
        </div>
      ))}
    </div>
  )
}

function Values({ values }: { values: string[] }) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {values.map((v) => (
        <code key={v} className="rounded-sm bg-ink-800 px-1 font-mono text-[12px] text-ink-200">
          {v}
        </code>
      ))}
    </span>
  )
}

/** A schema: its type, and its fields, each opened in place. `seen` is the refs above it, which a field that refers back to one stops at. */
function Schema({ doc, schema, seen }: { doc: unknown; schema: unknown; seen: string[] }) {
  const shape = shapeOf(doc, schema)
  const below = shape.ref ? [...seen, shape.ref] : seen
  return (
    <div className="rounded-md border border-ink-800 px-3 py-2">
      <div className="font-mono text-[12px] text-ink-300">
        {shape.label}
        {shape.nullable && ' | null'}
      </div>
      {shape.description && <p className="text-[13px] text-ink-400">{shape.description}</p>}
      {shape.values && <Values values={shape.values} />}
      {shape.fields.length > 0 && (
        <ul className="mt-1">
          {shape.fields.map((f) => (
            <Field key={f.name} name={f.name} required={f.required} schema={f.schema} doc={doc} seen={below} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Field({ name, required, schema, doc, seen }: { name: string; required: boolean; schema: unknown; doc: unknown; seen: string[] }) {
  const [open, setOpen] = useState(false)
  const shape = shapeOf(doc, schema)
  const loops = !!shape.ref && seen.includes(shape.ref)
  const opens = shape.fields.length > 0 && !loops
  const below = shape.ref ? [...seen, shape.ref] : seen
  const head = (
    <>
      <span className="font-mono text-[13px] break-all text-ink-100">{name}</span>
      <span className="font-mono text-[12px] text-ink-400">
        {shape.label}
        {shape.nullable && ' | null'}
        {loops && ' (as above)'}
      </span>
      {required && <span className="text-[12px] text-amber">required</span>}
    </>
  )
  return (
    <li className="border-t border-ink-800 py-1 first:border-0">
      {opens ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-baseline gap-x-2 text-left">
          {open ? <ChevronDown className="size-3 self-center text-ink-400" aria-hidden /> : <ChevronRight className="size-3 self-center text-ink-400" aria-hidden />}
          {head}
        </button>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2 pl-5">{head}</div>
      )}
      {(shape.description || shape.values) && (
        <div className="pl-5 text-[13px] text-ink-400">
          {shape.description}
          {shape.values && <Values values={shape.values} />}
        </div>
      )}
      {open && (
        <ul className="mt-1 ml-1.5 border-l border-ink-700 pl-3">
          {shape.fields.map((f) => (
            <Field key={f.name} name={f.name} required={f.required} schema={f.schema} doc={doc} seen={below} />
          ))}
        </ul>
      )}
    </li>
  )
}
