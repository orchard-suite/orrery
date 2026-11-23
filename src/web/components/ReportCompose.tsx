// Making and changing a report, as a form: the saved queries it reads, the
// blocks that show them in order, and what each written summary should say.
// The Query page shapes the data (its groups, totals, and chart); a block
// only names a query and how to show it. The form writes the same Markdown
// layout an agent would (`printLayout`), which the Markdown tab shows and
// takes, so nothing a form can say is out of an agent's reach or the reverse.

import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { REPORT_BLUEPRINT } from '../../shared/model.ts'
import { CHART_TYPES, draftOf, parseLayout, printLayout, TABLE_ROWS_DEFAULT, TABLE_ROWS_MAX, type ChartType, type DraftBlock, type LayoutDraft, type LayoutIssue } from '../../shared/report.ts'
import { CallError, checkLayout, useActions, useBlueprints, useRunAction, useSavedQueries } from '../api.ts'
import { freeName, withoutData } from '../report.ts'
import { navigate } from '../router.ts'
import { Drawer } from './Drawer.tsx'
import { HomePicker } from './HomePicker.tsx'
import { ErrorNote, input, Kicker, Link } from './ui.tsx'

/** The report a form changes: left out, it makes a new one. */
export interface Composed {
  key: string
  title: string
  layout: string
}

/** What a table or a scorecard judges and draws beyond its rows, said in a line. */
function marksLine(b: Extract<DraftBlock, { kind: 'table' | 'scorecard' }>): string {
  const judged = Object.keys(b.health ?? {})
  const marks = judged.length ? `Marks ${judged.join(', ')} as on track, to watch, or off track.` : 'Marks no column yet: set good and bad for a column under health, in the Markdown.'
  return b.kind === 'scorecard' ? `One row a thing, named by ${b.label ?? 'its first column'}${b.trend ? `, with ${b.trend.columns.length} trend bars` : ''}. ${marks}` : marks
}

const EMPTY: LayoutDraft = { data: {}, blocks: [] }

/** What each kind of block is called in the form. */
const KIND: Record<DraftBlock['kind'], string> = { heading: 'Heading', text: 'Text', stats: 'Numbers', chart: 'Chart', table: 'Table', scorecard: 'Scorecard', narrative: 'Written summary', rest: 'Summary, continued' }

export function ReportCompose({ report, query, onClose }: { report?: Composed; query?: { id: string; title: string }; onClose: () => void }) {
  const start = useMemo((): LayoutDraft => {
    if (report) return (({ layout }) => (layout ? draftOf(layout) : EMPTY))(parseLayout(report.layout))
    if (!query) return EMPTY
    const name = freeName(query.title, [])
    return { data: { [name]: { query: query.id } }, blocks: [{ kind: 'stats', data: name, items: [] }, { kind: 'table', data: name, limit: TABLE_ROWS_DEFAULT }] }
  }, [report, query])
  const [draft, setDraft] = useState<LayoutDraft>(start)
  const [title, setTitle] = useState(report?.title ?? query?.title ?? '')
  const [home, setHome] = useState<string | null>(null)
  const [note, setNote] = useState('')
  // The Markdown tab holds its own text while it is open, so a layout that does not read yet is not lost.
  const [source, setSource] = useState<string | null>(report && !parseLayout(report.layout).layout ? report.layout : null)
  const [issues, setIssues] = useState<LayoutIssue[]>([])
  const [failed, setFailed] = useState<unknown>(null)
  const queries = useSavedQueries()
  const actions = useActions()
  const blueprints = useBlueprints()
  const run = useRunAction()
  const writers = (actions.data?.actions ?? []).filter((a) => a.tool && a.inputs.instruction && a.inputs.data)
  const names = Object.keys(draft.data)
  const text = source ?? printLayout(draft)
  const changed = text !== (report?.layout ?? printLayout(EMPTY)) || title !== (report?.title ?? '')

  const set = (next: LayoutDraft) => {
    // A written summary needs a writer; the first the hub offers is taken until the person picks another.
    const writes = next.blocks.some((b) => b.kind === 'narrative')
    setDraft(writes && !next.writer && writers[0] ? { ...next, writer: writers[0].id } : next)
    setIssues([])
  }
  const block = (i: number, b: DraftBlock) => set({ ...draft, blocks: draft.blocks.map((x, k) => (k === i ? b : x)) })
  const move = (i: number, by: number) => {
    const blocks = [...draft.blocks]
    const [b] = blocks.splice(i, 1)
    blocks.splice(i + by, 0, b!)
    set({ ...draft, blocks })
  }
  const add = (kind: DraftBlock['kind']) => {
    const first = names[0] ?? ''
    const made: DraftBlock = kind === 'heading' ? { kind, level: 2, text: '' } : kind === 'text' ? { kind, text: '' } : kind === 'stats' ? { kind, data: first, items: [] } : kind === 'chart' ? { kind, data: first, y: [] } : kind === 'table' || kind === 'scorecard' ? { kind, data: first, limit: TABLE_ROWS_DEFAULT } : kind === 'rest' ? { kind } : { kind, data: first ? [first] : [], instruction: '' }
    set({ ...draft, blocks: [...draft.blocks, made] })
  }
  const openSource = () => setSource(printLayout(draft))
  const closeSource = () => {
    const read = parseLayout(source ?? '')
    if (!read.layout) return setIssues(read.issues)
    setDraft(draftOf(read.layout))
    setSource(null)
    setIssues([])
  }

  const save = async () => {
    setFailed(null)
    try {
      const checked = await checkLayout(text)
      if (checked.issues.length) return setIssues(checked.issues)
      if (report) {
        await run.mutateAsync({ id: 'orrery_report_edit', entity: { blueprint: REPORT_BLUEPRINT, key: report.key }, inputs: { layout: text, ...(note.trim() ? { note: note.trim() } : {}) } })
        onClose()
        return
      }
      const made = await run.mutateAsync({ id: 'orrery_report_new', inputs: { title: title.trim(), home, layout: text } })
      const key = made.link ? decodeURIComponent(new URL(made.link).pathname.split('/').filter(Boolean).at(-1) ?? '') : ''
      onClose()
      if (key) navigate({ page: 'report', key })
    } catch (error) {
      setFailed(error instanceof CallError && error.input === 'layout' ? new Error(`The layout does not read:\n${error.message}`) : error)
    }
  }

  const ready = !!text.trim() && (report ? true : !!title.trim() && !!home)
  return (
    <Drawer title={report ? `Edit ${report.title}` : 'New report'} subtitle={<p>Pick saved queries, put them in order, and say what each written summary should tell. Shape a number or a chart on the Query page, in its query.</p>} onClose={onClose} unsaved={changed} width={680}>
      <form className="space-y-5 p-4" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void save() }}>
        {!report && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[13px] text-ink-200">
              Title
              <input className={`${input} mt-1 block w-full`} value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <div className="text-[13px] text-ink-200">
              <span id="report-home">Home</span>
              <div className="mt-1" aria-labelledby="report-home">
                <HomePicker value={home} blueprints={blueprints.data?.blueprints ?? []} onChange={setHome} />
              </div>
              <p className="mt-1 text-[12px] text-ink-400">Usually a team. Whoever owns it may change the report, and whoever sees it reads it.</p>
            </div>
          </div>
        )}
        <div role="tablist" aria-label="How to edit the layout" className="flex gap-4 border-b border-ink-700 text-[13px]">
          <button type="button" role="tab" aria-selected={source === null} className={`-mb-px border-b-2 px-0.5 py-1.5 ${source === null ? 'border-orbit text-ink-50' : 'border-transparent text-ink-300'}`} onClick={() => source !== null && closeSource()}>Build</button>
          <button type="button" role="tab" aria-selected={source !== null} className={`-mb-px border-b-2 px-0.5 py-1.5 ${source !== null ? 'border-orbit text-ink-50' : 'border-transparent text-ink-300'}`} onClick={() => source === null && openSource()}>Markdown</button>
        </div>
        {source !== null ? (
          <label className="block text-[13px] text-ink-200">
            The layout as text
            <textarea className={`${input} mt-1 block min-h-96 w-full font-mono text-[12px]`} value={source} spellCheck={false} onChange={(e) => { setSource(e.target.value); setIssues([]) }} />
          </label>
        ) : (
          <>
            <section aria-label="Data">
              <Kicker>Data</Kicker>
              <ul className="mt-2 space-y-1.5">
                {names.map((name) => {
                  const def = draft.data[name]!
                  const saved = 'query' in def ? queries.data?.queries.find((q) => q.id === def.query) : undefined
                  return (
                    <li key={name} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 px-2.5 py-1.5 text-[13px]">
                      <span className="font-mono text-[12px] text-ink-300">{name}</span>
                      <span className="min-w-0 flex-1 text-ink-100">{'query' in def ? (saved?.title ?? 'A saved query you cannot open') : `Tool ${def.tool}`}</span>
                      {'query' in def && <Link to={{ page: 'query', id: def.query }} className="text-[12px] text-orbit hover:underline">Open query</Link>}
                      <button type="button" className="text-ink-300 hover:text-red" aria-label={`Remove data ${name}`} onClick={() => set(withoutData(draft, name))}><Trash2 aria-hidden className="size-4" /></button>
                    </li>
                  )
                })}
              </ul>
              <label className="mt-2 block text-[13px] text-ink-200">
                Add a saved query
                <select className={`${input} mt-1 block w-full`} value="" onChange={(e) => { const q = queries.data?.queries.find((x) => x.id === e.target.value); if (q) set({ ...draft, data: { ...draft.data, [freeName(q.title, names)]: { query: q.id } } }) }}>
                  <option value="">Pick one…</option>
                  {(queries.data?.queries ?? []).map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
                </select>
              </label>
              <p className="mt-1 text-[12px] text-ink-400">A report reads each query as its owner sees it. <Link to={{ page: 'query', id: null }} className="text-orbit hover:underline">Make a query</Link> first when the data you want is not here.</p>
            </section>
            <section aria-label="Blocks">
              <Kicker>Blocks</Kicker>
              <ol className="mt-2 space-y-2">
                {draft.blocks.map((b, i) => (
                  <li key={i} className="rounded-md border border-ink-700 p-2.5">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[13px] font-medium text-ink-100">{KIND[b.kind]}</span>
                      <span className="flex-1" />
                      <button type="button" className="text-ink-300 hover:text-ink-50 disabled:opacity-40" aria-label={`Move ${KIND[b.kind]} ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp aria-hidden className="size-4" /></button>
                      <button type="button" className="text-ink-300 hover:text-ink-50 disabled:opacity-40" aria-label={`Move ${KIND[b.kind]} ${i + 1} down`} disabled={i === draft.blocks.length - 1} onClick={() => move(i, 1)}><ArrowDown aria-hidden className="size-4" /></button>
                      <button type="button" className="text-ink-300 hover:text-red" aria-label={`Remove ${KIND[b.kind]} ${i + 1}`} onClick={() => set({ ...draft, blocks: draft.blocks.filter((_x, k) => k !== i) })}><Trash2 aria-hidden className="size-4" /></button>
                    </div>
                    <BlockForm block={b} names={names} onChange={(next) => block(i, next)} />
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['stats', 'chart', 'table', 'narrative', 'heading', 'text'] as const).map((kind) => {
                  const needsData = kind !== 'heading' && kind !== 'text'
                  const off = (needsData && !names.length) || (kind === 'narrative' && !writers.length && !draft.writer)
                  return <button key={kind} type="button" className="btn btn-ghost" disabled={off} title={off ? (kind === 'narrative' && names.length ? 'This hub has no writer tool yet: an admin defines one' : 'Add data first') : undefined} onClick={() => add(kind)}>+ {KIND[kind]}</button>
                })}
              </div>
              {draft.blocks.some((b) => b.kind === 'narrative') && writers.length > 1 && (
                <label className="mt-3 block text-[13px] text-ink-200">
                  Written by
                  <select className={`${input} mt-1 block w-full`} value={draft.writer ?? ''} onChange={(e) => set({ ...draft, writer: e.target.value })}>
                    {writers.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
                  </select>
                </label>
              )}
            </section>
          </>
        )}
        {report && (
          <label className="block text-[13px] text-ink-200">
            What changed
            <input className={`${input} mt-1 block w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Kept with the new version" />
          </label>
        )}
        {issues.length > 0 && (
          <div role="alert" className="rounded-md border border-red-dim bg-red/5 px-3 py-2 text-[13px] text-red">
            <p className="font-medium">The layout does not read yet:</p>
            <ul className="mt-1 list-disc pl-5">{issues.map((i, k) => <li key={k}>Line {i.line}: {i.message}</li>)}</ul>
          </div>
        )}
        <ErrorNote error={failed} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-solid" disabled={!ready || run.isPending}>{report ? 'Save as the next version' : 'Make the report'}</button>
        </div>
      </form>
    </Drawer>
  )
}

/** The button that opens the form on a report, for whoever may change it. */
export function EditReport({ report, className }: { report: Composed; className: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" aria-haspopup="dialog" className={className} onClick={() => setOpen(true)}>
        <Pencil aria-hidden className="size-3.5" /> Edit
      </button>
      {open && <ReportCompose report={report} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The data set a block reads, picked from the ones the report names. */
function DataPick({ value, names, onChange }: { value: string; names: readonly string[]; onChange: (v: string) => void }) {
  return (
    <label className="block text-[12px] text-ink-300">
      Data
      <select className={`${input} mt-1 block w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
        {!names.includes(value) && <option value={value}>{value || 'Pick…'}</option>}
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  )
}

function Titled({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <label className="block text-[12px] text-ink-300">
      Title
      <input className={`${input} mt-1 block w-full`} value={value ?? ''} placeholder="None" onChange={(e) => onChange(e.target.value.trim() ? e.target.value : undefined)} />
    </label>
  )
}

/** A block without its title when the title is empty: a layout never keeps an empty one. */
function retitled<B extends { title?: string }>(b: B, title: string | undefined): B {
  const { title: _old, ...rest } = b
  return (title === undefined ? rest : { ...rest, title }) as B
}

function BlockForm({ block: b, names, onChange }: { block: DraftBlock; names: readonly string[]; onChange: (b: DraftBlock) => void }) {
  if (b.kind === 'heading')
    return (
      <div className="flex gap-2">
        <select className={input} aria-label="Heading size" value={b.level} onChange={(e) => onChange({ ...b, level: Number(e.target.value) as 1 | 2 | 3 })}>
          <option value={1}>Large</option>
          <option value={2}>Medium</option>
          <option value={3}>Small</option>
        </select>
        <input className={`${input} min-w-0 flex-1`} aria-label="Heading" value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} />
      </div>
    )
  if (b.kind === 'text') return <textarea className={`${input} block min-h-16 w-full`} aria-label="Text" value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} />
  if (b.kind === 'narrative')
    return (
      <div className="space-y-2">
        <fieldset className="text-[12px] text-ink-300">
          <legend>Written from</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {names.map((n) => (
              <label key={n} className="flex items-center gap-1.5 text-ink-100">
                <input type="checkbox" checked={b.data.includes(n)} onChange={(e) => onChange({ ...b, data: e.target.checked ? [...b.data, n] : b.data.filter((d) => d !== n) })} />
                {n}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-[12px] text-ink-300">
          What it should say
          <textarea className={`${input} mt-1 block min-h-24 w-full`} value={b.instruction} placeholder="In three sentences, say how the week went. Name what got worse." onChange={(e) => onChange({ ...b, instruction: e.target.value })} />
        </label>
        <p className="text-[12px] text-ink-400">It may ask for headings, bullets, a table, or links. Numbers in the blocks around it come from the data, never from the writer.</p>
        <Titled value={b.title} onChange={(t) => onChange(retitled(b, t))} />
      </div>
    )
  if (b.kind === 'rest')
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-ink-400">The written summary above stands as its first paragraph alone. The rest of it is drawn here.</p>
        <Titled value={b.title} onChange={(t) => onChange(retitled(b, t))} />
      </div>
    )
  if (b.kind === 'stats')
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <DataPick value={b.data} names={names} onChange={(data) => onChange({ ...b, data })} />
        <Titled value={b.title} onChange={(t) => onChange(retitled(b, t))} />
        <p className="text-[12px] text-ink-400 sm:col-span-2">{b.items.length ? `Shows ${b.items.length === 1 ? 'one number' : `${b.items.length} numbers`} set in the Markdown.` : 'Shows the totals its query adds up, or how many rows it holds.'}</p>
      </div>
    )
  if (b.kind === 'chart') {
    const typed = (type: string): DraftBlock => {
      const { type: _old, ...rest } = b
      return type ? { ...rest, type: type as ChartType } : rest
    }
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <DataPick value={b.data} names={names} onChange={(data) => onChange({ ...b, data })} />
        <label className="block text-[12px] text-ink-300">
          Drawn as
          <select className={`${input} mt-1 block w-full`} value={b.type ?? ''} onChange={(e) => onChange(typed(e.target.value))}>
            <option value="">As its query shows it</option>
            {CHART_TYPES.map((t) => <option key={t} value={t}>{t === 'trend' ? 'A line over the rows' : t === 'bars' ? 'Bars, one a row' : 'Bars beside the last edition'}</option>)}
          </select>
        </label>
        <Titled value={b.title} onChange={(t) => onChange(retitled(b, t))} />
        <p className="self-end text-[12px] text-ink-400">{b.x || b.y.length ? `Draws ${b.y.join(', ') || 'its first number'} by ${b.x ?? 'its first column'}, set in the Markdown.` : 'Draws what its query groups and adds up.'}</p>
      </div>
    )
  }
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <DataPick value={b.data} names={names} onChange={(data) => onChange({ ...b, data })} />
      <Titled value={b.title} onChange={(t) => onChange(retitled(b, t))} />
      <label className="block text-[12px] text-ink-300">
        Rows shown
        <input type="number" min={1} max={TABLE_ROWS_MAX} className={`${input} mt-1 block w-full`} value={b.limit} onChange={(e) => onChange({ ...b, limit: Math.min(TABLE_ROWS_MAX, Math.max(1, Math.trunc(Number(e.target.value)) || 1)) })} />
      </label>
      <p className="text-[12px] text-ink-400 sm:col-span-3">{marksLine(b)}</p>
    </div>
  )
}
