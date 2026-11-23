/**
 * How a backend names the steps of a run and the values it ends with, inside the lines it reports.
 * `::step:: <name>` starts a step, `::output:: <name>=<value>` sets an output, `::refresh:: <field>=<json>`
 * hands back a value of the run's entity to write once it succeeds, `::final::` says the try's failure is the answer, so a run whose action retries is not tried again, and a JSON log line
 * that carries a `step` starts that step. A marker that breaks a rule here is an ordinary line:
 * nothing a backend says is ever dropped.
 */

/** The longest a step's name may be. */
export const STEP_NAME_MAX = 80
/** The longest an output's text may be. */
export const OUTPUT_VALUE_MAX = 2000
/** The longest an image output may be, as its data address. */
export const OUTPUT_IMAGE_MAX = 256 * 1024
/** How many outputs one run holds. */
export const OUTPUTS_MAX = 50
/** The longest a value handed back to write on the run's entity may be, as it is written on its line. */
export const REFRESH_VALUE_MAX = 64 * 1024
/** What an output's name may be. */
export const OUTPUT_NAME = /^[A-Za-z0-9_.-]{1,64}$/

const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/** Whether an output is a picture: a PNG, JPEG, or WebP image as a base64 data address. The run page shows it as one. */
export function isImageOutput(value: string): boolean {
  return value.startsWith('data:image/') && IMAGE.test(value)
}

/** Whether an output's text is within its limit: an image's, or a text's. */
export function outputFits(value: string): boolean {
  return value.length <= OUTPUT_VALUE_MAX || (value.length <= OUTPUT_IMAGE_MAX && isImageOutput(value))
}

/** An output as text for a place that shows no picture, such as a notification or an agent's answer: an image says what it is. */
export function outputText(value: unknown): string {
  const s = String(value)
  return isImageOutput(s) ? `(${s.slice(5, s.indexOf(';'))}, ${Math.ceil(((s.length - s.indexOf(',') - 1) * 3) / 4 / 1024)} KB; shown on the run page)` : s
}

/** A value a run ended with. */
export type OutputValue = string | number | boolean

/** One line of a run's log, under the step that was under way when it came. */
export interface RunLine {
  at: string
  message: string
  step?: string
}

/** A step a backend named, and when it started. */
export interface RunStep {
  name: string
  at: string
}

export type Mark =
  /** The line starts a step. `kept` is false for the marker, which is not a log line itself. */
  | { kind: 'step'; name: string; kept: boolean }
  | { kind: 'output'; name: string; value: string }
  /** A value of the run's entity the backend hands back, to write once the run succeeds. */
  | { kind: 'refresh'; field: string; value: unknown }
  /** The try's failure is final: trying again would only say it again. */
  | { kind: 'final' }
  | { kind: 'line' }

const STEP = /^::step::\s+(.+)$/
const OUTPUT = /^::output::\s+([^=]+)=(.*)$/
const REFRESH = /^::refresh::\s+([^=]+)=(.*)$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const LINE: Mark = { kind: 'line' }

/** A name a step may carry: trimmed, not empty, not too long. */
export function stepName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && name.length <= STEP_NAME_MAX ? name : null
}

/** What one reported line is, given the step under way. */
export function readMark(under: string | null, line: string): Mark {
  if (line.trimEnd() === '::final::') return { kind: 'final' }
  if (line.startsWith('::step::')) {
    const name = stepName(STEP.exec(line.trimEnd())?.[1])
    return name ? { kind: 'step', name, kept: false } : LINE
  }
  if (line.startsWith('::output::')) {
    const found = OUTPUT.exec(line.trimEnd())
    if (!found) return LINE
    const name = found[1]!.trim()
    const value = found[2]!.trim()
    return OUTPUT_NAME.test(name) && outputFits(value) ? { kind: 'output', name, value } : LINE
  }
  if (line.startsWith('::refresh::')) {
    const found = REFRESH.exec(line.trimEnd())
    if (!found) return LINE
    const field = found[1]!.trim()
    const raw = found[2]!.trim()
    return FIELD_NAME.test(field) && raw.length <= REFRESH_VALUE_MAX ? { kind: 'refresh', field, value: refreshValue(raw) } : LINE
  }
  if (line.startsWith('{')) {
    const name = stepName(jsonStep(line))
    return name && name !== under ? { kind: 'step', name, kept: true } : LINE
  }
  return LINE
}

/** A handed-back value as it is written: JSON, or, where it is not JSON, the text itself. */
export function refreshValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function jsonStep(line: string): unknown {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).step : undefined
  } catch {
    return undefined
  }
}

export interface Reading {
  /** The lines to keep, each under its step. */
  log: RunLine[]
  /** The steps these lines started. */
  steps: RunStep[]
  /** The outputs these lines set. */
  outputs: Record<string, string>
  /** The values of the run's entity these lines handed back, by field: the last for a field wins. */
  refresh: Record<string, unknown>
  /** The step under way after the last line. */
  under: string | null
  /** Whether a line said the try's failure is final. */
  final: boolean
}

/**
 * Reads a report's lines in order. `step` is the step the run is in before the first line, and
 * `held` the names of the outputs it holds: an output that would take the run past `OUTPUTS_MAX`
 * stays a line.
 */
export function readLines(lines: readonly string[], from: { step: string | null; held: readonly string[] }, at: string): Reading {
  const held = new Set(from.held)
  const read: Reading = { log: [], steps: [], outputs: {}, refresh: {}, under: from.step, final: false }
  for (const message of lines) {
    const mark = readMark(read.under, message)
    if (mark.kind === 'final') {
      read.final = true
      continue
    }
    if (mark.kind === 'output' && (held.has(mark.name) || held.size < OUTPUTS_MAX)) {
      held.add(mark.name)
      read.outputs[mark.name] = mark.value
      continue
    }
    if (mark.kind === 'refresh') {
      read.refresh[mark.field] = mark.value
      continue
    }
    if (mark.kind === 'step') {
      if (mark.name !== read.under) read.steps.push({ name: mark.name, at })
      read.under = mark.name
      if (!mark.kept) continue
    }
    read.log.push(read.under === null ? { at, message } : { at, message, step: read.under })
  }
  return read
}
