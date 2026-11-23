// A run's log: its lines under the steps the backend named, in a terminal's
// colours drawn as the theme's own, with a search, a copy, and a file to keep.

import { Check, ChevronRight, Circle, CircleDot, CircleHelp, Minus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isFinished, type ActionRun } from '../../shared/model.ts'
import type { RunStep } from '../../shared/run-marks.ts'
import type { Happened } from '../actions.ts'
import { duration, exact } from '../format.ts'
import { ansi, groups, logText, searched, since, stepTimes, type AnsiColor, type Group, type Line, type Span, type StepTime } from '../runlog.ts'
import { CopyButton, DownloadButton, Kicker, Panel, input } from './ui.tsx'

/** How a part of a run stands, as a shape. `STEP_WORD` says it beside the shape, so it is never the colour alone. */
export const STEP_ICON: Record<Happened['status'], ReactNode> = {
  done: <Check aria-hidden className="size-3.5 shrink-0 text-green" />,
  now: <CircleDot aria-hidden className="size-3.5 shrink-0 text-orbit" />,
  failed: <X aria-hidden className="size-3.5 shrink-0 text-red" />,
  unknown: <CircleHelp aria-hidden className="size-3.5 shrink-0 text-amber" />,
  waiting: <Circle aria-hidden className="size-3.5 shrink-0 text-ink-500" />,
  skipped: <Minus aria-hidden className="size-3.5 shrink-0 text-ink-500" />,
}
export const STEP_WORD: Record<Happened['status'], string> = { done: 'done', now: 'in progress', failed: 'failed', unknown: 'not known', waiting: 'not yet', skipped: 'skipped' }

/** Each of a terminal's colours as a token class, plain and bright. Whole class names, so the stylesheet keeps each one. */
const INK: Record<AnsiColor, [plain: string, bright: string]> = {
  black: ['text-ink-500', 'text-ink-400'],
  red: ['text-red', 'text-ansi-red-bright'],
  green: ['text-green', 'text-ansi-green-bright'],
  yellow: ['text-amber', 'text-ansi-yellow-bright'],
  blue: ['text-orbit', 'text-ansi-blue-bright'],
  magenta: ['text-ansi-magenta', 'text-ansi-magenta-bright'],
  cyan: ['text-ansi-cyan', 'text-ansi-cyan-bright'],
  white: ['text-ink-200', 'text-ink-50'],
}
const look = (s: Span): string => [s.color && INK[s.color][s.bright ? 1 : 0], s.bold && 'font-semibold'].filter(Boolean).join(' ')

/** How many of a group's last lines are drawn until a person asks for the ones before them: a very long log stays light. */
const TAIL = 1000
const NO_STEPS: RunStep[] = []

/**
 * The log, oldest first. Lines before the first step sit under no heading;
 * each step is a heading that opens and closes, open while it is under way,
 * where the run failed, and when it is the only one. While it follows, each
 * new line scrolls into view. A search keeps only the lines that match.
 */
export function RunLog({ run, now }: { run: ActionRun; now: number }) {
  const box = useRef<HTMLDivElement>(null)
  const steps = run.steps ?? NO_STEPS
  const [follow, setFollow] = useState(!isFinished(run.state))
  const [query, setQuery] = useState('')
  // What a person opened or closed by hand: by the whole log, and by what a search found, which is forgotten with the search.
  const [turned, setTurned] = useState<Record<number, boolean>>({})
  const [turnedFound, setTurnedFound] = useState<Record<number, boolean>>({})
  const [earlier, setEarlier] = useState<Record<number, number>>({})
  const all = useMemo(() => groups(run.log, steps), [run.log, steps])
  const { groups: shown, found, of } = useMemo(() => searched(all, query), [all, query])
  const times = stepTimes({ ...run, steps }, now)
  const start = run.startedAt ?? run.createdAt
  const searching = query.trim() !== ''
  const headed = all.filter((g) => g.name !== null).length
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [follow, run.log.length])
  const tool = 'flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[12px] text-ink-300 hover:bg-ink-800 hover:text-ink-100'
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 px-4 py-2">
        <h2>
          <Kicker>Log · {run.log.length}</Kicker>
        </h2>
        <input
          type="search"
          aria-label="Search the log"
          placeholder="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setTurnedFound({})
          }}
          className={`${input} min-w-24 flex-1 py-1 text-[12px] sm:max-w-56`}
        />
        <span aria-live="polite" className="text-[12px] text-ink-300">
          {searching ? `${found} of ${of} lines` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <label className={`${tool} min-h-6 gap-1.5`}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          <CopyButton text={() => logText(run.log)} />
          <DownloadButton text={() => logText(run.log)} file={`${run.id}.log`} />
        </div>
      </div>
      <div ref={box} role="log" aria-label="Run log" tabIndex={0} className="max-h-[60vh] overflow-y-auto py-1 font-mono text-[12px]">
        {shown.length === 0 && <p className="px-4 py-3 font-sans text-sm text-ink-400">{searching ? 'No line matches.' : 'No lines yet.'}</p>}
        {shown.map((g) => {
          const key = g.lines[0]!.n
          const more = () => setEarlier((e) => ({ ...e, [key]: (e[key] ?? 0) + TAIL }))
          // Lines under no step that follow a step are ruled off from it, so they never read as part of it.
          if (g.name === null)
            return (
              <div key={key} className="border-t border-ink-800 py-1 first:border-t-0 first:pt-0">
                <Lines lines={g.lines} start={start} earlier={earlier[key] ?? 0} onEarlier={more} />
              </div>
            )
          const time = g.step === null ? undefined : times[g.step]
          const open = (searching ? turnedFound[key] : turned[key]) ?? (searching || !time || time.status !== 'done' || headed === 1)
          const turn = (to: boolean) => (searching ? setTurnedFound((t) => ({ ...t, [key]: to })) : setTurned((t) => ({ ...t, [key]: to })))
          return (
            <StepLines key={key} group={g} time={time} open={open} onTurn={turn}>
              <Lines lines={g.lines} start={start} earlier={earlier[key] ?? 0} onEarlier={more} />
            </StepLines>
          )
        })}
      </div>
    </Panel>
  )
}

/** A step's lines under its heading: its name, how it stands, how many lines, and how long it took. Closed, it draws no lines. */
function StepLines({ group, time, open, onTurn, children }: { group: Group; time: StepTime | undefined; open: boolean; onTurn: (open: boolean) => void; children: ReactNode }) {
  const n = group.lines.length
  return (
    <details open={open} className="border-t border-ink-800 first:border-t-0">
      {/* The page decides what is open, so the browser's own toggle is taken over. A key press on a summary is a click. */}
      <summary
        onClick={(e) => {
          e.preventDefault()
          onTurn(!open)
        }}
        className="flex cursor-pointer list-none items-center gap-2 px-4 py-1.5 font-sans text-[13px] hover:bg-ink-850 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-ink-400 ${open ? 'rotate-90' : ''}`} />
        {time && (
          <>
            {STEP_ICON[time.status]}
            <span className="sr-only">{STEP_WORD[time.status]}</span>
          </>
        )}
        <span className="min-w-0 truncate font-medium text-ink-100">{group.name}</span>
        {group.continued && <span className="shrink-0 text-[12px] text-ink-400">continued</span>}
        <span className="ml-auto shrink-0 text-[12px] text-ink-400">
          {n === 1 ? '1 line' : `${n} lines`}
          {time && !group.continued && ` · ${duration(time.ms)}`}
        </span>
      </summary>
      {open && children}
    </details>
  )
}

/** Lines in order: how long after the run started each came, then what it said. Only the last of a great many are drawn until the earlier ones are asked for. */
function Lines({ lines, start, earlier, onEarlier }: { lines: Line[]; start: string; earlier: number; onEarlier: () => void }) {
  const held = Math.max(0, lines.length - TAIL - earlier)
  return (
    <>
      {held > 0 && (
        <button type="button" onClick={onEarlier} className="mx-4 my-1 rounded-sm px-1.5 py-1 font-sans text-[12px] font-medium text-ink-200 hover:bg-ink-800 hover:text-ink-50">
          Show {Math.min(held, TAIL)} earlier lines of {held}
        </button>
      )}
      <ol>
        {(held > 0 ? lines.slice(held) : lines).map((line) => (
          <li key={line.n} className="flex gap-3 px-4 py-0.5 hover:bg-ink-850">
            <time dateTime={line.at} title={exact(line.at)} className="w-12 shrink-0 text-right tabular-nums text-ink-400">
              {since(start, line.at)}
            </time>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${line.level === 'error' ? 'text-red' : line.level === 'warn' ? 'text-amber' : 'text-ink-200'}`} title={line.text === line.raw ? undefined : line.raw}>
              {line.level !== 'info' && <span className="font-semibold">{line.level === 'error' ? 'Error: ' : 'Warning: '}</span>}
              {ansi(line.text).map((s, i) => (s.color || s.bold ? <span key={i} className={look(s)}>{s.text}</span> : s.text))}
            </span>
          </li>
        ))}
      </ol>
    </>
  )
}
