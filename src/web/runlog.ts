// A run's log as a person reads it. A runner job writes JSON lines, the way
// every command on the platform logs; the run page shows each as its
// message, with what else it says beside it, and leaves any other line as it
// is. A line may carry a terminal's colours, which are read here and drawn
// in the theme's own; the lines sit under the steps the backend named.

import { isFinished, type ActionRun } from '../shared/model.ts'
import type { RunLine, RunStep } from '../shared/run-marks.ts'

/** One log line made readable: its words, and how serious it is. */
export interface ReadLine {
  text: string
  level: 'info' | 'warn' | 'error'
}

/** What every line of a command carries, which says nothing about the run. A line's step is its heading. */
const PLUMBING = new Set(['time', 'level', 'msg', 'component', 'version', 'summary', 'step'])

export function readLine(message: string): ReadLine {
  if (!message.startsWith('{')) return { text: message, level: 'info' }
  let line: unknown
  try {
    line = JSON.parse(message)
  } catch {
    return { text: message, level: 'info' }
  }
  if (!line || typeof line !== 'object' || Array.isArray(line) || typeof (line as { msg?: unknown }).msg !== 'string') return { text: message, level: 'info' }
  const fields = line as Record<string, unknown>
  const rest = Object.entries(fields)
    .filter(([k]) => !PLUMBING.has(k))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  const level = String(fields.level ?? '').toLowerCase()
  return { text: [fields.msg as string, ...rest].join(' · '), level: level === 'error' ? 'error' : level === 'warn' || level === 'warning' ? 'warn' : 'info' }
}

/** The eight colours a terminal names. Each has a bright one. */
export type AnsiColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
const COLORS: AnsiColor[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/** A stretch of a line drawn one way. */
export interface Span {
  text: string
  color?: AnsiColor
  bright?: boolean
  bold?: boolean
}

// Every escape a terminal reads: a control sequence (colours among them), an operating system command such as a window title, and the two-character ones. A carriage return goes with them.
const ESCAPE = /\u001b\[([0-9;:?<=>]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -/]*[0-~]?|\r/g

/** A line with every escape gone. */
export function plain(text: string): string {
  return text.includes('\u001b') || text.includes('\r') ? text.replace(ESCAPE, '') : text
}

/**
 * A line as the stretches a terminal would colour: the eight colours and
 * their bright ones, bold, and the resets. Every other escape is dropped,
 * and so is a colour this page does not draw: a background, or one of the
 * 256 or the sixteen million.
 */
export function ansi(text: string): Span[] {
  if (!text.includes('\u001b') && !text.includes('\r')) return text ? [{ text }] : []
  const spans: Span[] = []
  let look: Omit<Span, 'text'> = {}
  const push = (part: string) => {
    if (!part) return
    const last = spans.at(-1)
    if (last && last.color === look.color && last.bright === look.bright && last.bold === look.bold) last.text += part
    else spans.push({ text: part, ...look })
  }
  let from = 0
  for (const found of text.matchAll(ESCAPE)) {
    push(text.slice(from, found.index))
    from = found.index + found[0].length
    if (found[2] === 'm') look = styled(look, found[1] ?? '')
  }
  push(text.slice(from))
  return spans
}

/** The look after one colour sequence. */
function styled(was: Omit<Span, 'text'>, params: string): Omit<Span, 'text'> {
  const look = { ...was }
  const codes = params === '' ? [0] : params.split(';').map((c) => Number(c) || 0)
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) {
      delete look.color
      delete look.bright
      delete look.bold
    } else if (code === 1) look.bold = true
    else if (code === 22) delete look.bold
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      look.color = COLORS[code % 10]!
      if (code >= 90) look.bright = true
      else delete look.bright
    } else if (code === 39) {
      delete look.color
      delete look.bright
    } else if (code === 38 || code === 48) {
      // One of the 256 takes two more numbers, a true colour four. Neither is drawn, and neither's numbers are read as codes.
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
    }
  }
  return look
}

/** A line of a run's log, ready to draw. `n` is its place in the whole log. */
export interface Line extends ReadLine {
  n: number
  at: string
  /** The line as it came. */
  raw: string
}

/** Consecutive lines under one step, or under none. */
export interface Group {
  /** Which of the run's steps, by its place among them, or null for lines under no step or under one the run does not list. */
  step: number | null
  name: string | null
  /** An earlier group holds this step's first lines: a line under no step came between them. */
  continued: boolean
  lines: Line[]
}

/**
 * The log in order, cut wherever the step changes. A line belongs to the
 * last start of its step at or before it, so a step named again later is a
 * group of its own. A hub one release back sends no step on a line and no
 * steps: its log is one group under no heading.
 */
export function groups(log: readonly RunLine[], steps: readonly RunStep[]): Group[] {
  const out: Group[] = []
  const seen = new Set<number>()
  let key: string | null = null
  log.forEach((line, n) => {
    const step = line.step === undefined ? null : startOf(steps, line.step, line.at)
    const name = line.step ?? null
    const at = `${step}\u0000${name ?? ''}`
    if (at !== key) {
      key = at
      out.push({ step, name, continued: step !== null && seen.has(step), lines: [] })
      if (step !== null) seen.add(step)
    }
    out.at(-1)!.lines.push({ n, at: line.at, raw: line.message, ...readLine(line.message) })
  })
  return out
}

/** The last start of a step by this name at or before a time; else its last start; null when the run lists none. */
function startOf(steps: readonly RunStep[], name: string, at: string): number | null {
  let last: number | null = null
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.name !== name) continue
    if (last !== null && steps[i]!.at > at) break
    last = i
  }
  return last
}

/** A step a backend named, how long it took or has taken, and how it stands. */
export interface StepTime extends RunStep {
  ms: number
  status: 'done' | 'now' | 'failed'
}

/** Each step timed to the next one, to the run's finish, or to `now` for the one under way. The last step of a failed run is the one it failed in. */
export function stepTimes(run: Pick<ActionRun, 'state' | 'finishedAt'> & { steps?: readonly RunStep[] }, now: number): StepTime[] {
  const steps = run.steps ?? []
  return steps.map((step, i) => {
    const last = i === steps.length - 1
    const end = last ? (run.finishedAt ? Date.parse(run.finishedAt) : now) : Date.parse(steps[i + 1]!.at)
    return { ...step, ms: Math.max(0, end - Date.parse(step.at)), status: !last ? 'done' : run.state === 'failed' ? 'failed' : isFinished(run.state) ? 'done' : 'now' }
  })
}

/** How long after `from` a moment came, as a clock: `+0:42`, `+3:07`, `+1:03:07`. */
export function since(from: string, at: string): string {
  const s = Math.max(0, Math.floor((Date.parse(at) - Date.parse(from)) / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `+${h}:${two(m)}:${two(s % 60)}` : `+${m}:${two(s % 60)}`
}

/** The groups cut down to the lines that hold what is searched for, whatever its case, with how many lines that is of how many. */
export function searched(all: Group[], query: string): { groups: Group[]; found: number; of: number } {
  const of = all.reduce((n, g) => n + g.lines.length, 0)
  const want = query.trim().toLowerCase()
  if (!want) return { groups: all, found: of, of }
  const kept = all.map((g) => ({ ...g, lines: g.lines.filter((l) => plain(l.text).toLowerCase().includes(want)) })).filter((g) => g.lines.length > 0)
  return { groups: kept, found: kept.reduce((n, g) => n + g.lines.length, 0), of }
}

/** The whole log as plain text, a line each with its time, to copy or to keep as a file. */
export function logText(log: readonly RunLine[]): string {
  return log.map((l) => `${l.at} ${plain(l.message)}\n`).join('')
}
