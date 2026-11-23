// The kinds of input an action's form asks for, in one registry. A kind says
// what it is, which options and rules fit it, how one value of it is checked
// and stored, and how it reads as text. The hub, the form, the builder, and
// the run page all read it, so a new kind is one entry here and a control in
// the form. Nothing here reads the model, so the model can take its list of
// input types from it.

/** An option of an input's definition that only some kinds take. */
export type InputOption = 'many' | 'values' | 'display' | 'blueprint' | 'where' | 'sort' | 'current' | 'narrows' | 'unique' | 'show'

/** A rule a value must keep, beyond being of its kind. */
export type InputRule = 'pattern' | 'min' | 'max' | 'minLength' | 'maxLength'
export const INPUT_RULES: readonly InputRule[] = ['pattern', 'min', 'max', 'minLength', 'maxLength']

/** The rules on an input, and what to say when one fails. */
export interface InputRules {
  /** A regular expression the whole value must match. */
  pattern?: string
  /** The least a number, a date, or a date and time may be. A date takes a day, or `today`, `today+30d`, `today-1y`, counted in UTC days. */
  min?: number | string
  /** The most it may be, written as `min` is. */
  max?: number | string
  /** The fewest characters a text may hold, or the fewest picks of a list that picks. */
  minLength?: number
  /** The most characters, or picks. */
  maxLength?: number
  /** What a person is told when a rule fails, in place of the rule's own words. */
  hint?: string
}

/** What a check knows besides the value: nothing the hub alone could tell it. */
export interface CheckContext {
  /** The day it is in UTC, as YYYY-MM-DD: what `today` in a bound means. */
  today: string
  /** For a kind that picks from values: the values, as the caller rendered them. */
  allowed?: readonly string[]
  /** For a kind that picks an entity: the blueprints it picks from. */
  picks?: readonly string[]
}

/** A checked value as it is stored, or why it was refused. */
export type Checked = { ok: true; value: unknown } | { ok: false; error: string }

export interface InputKind {
  /** What the builder calls it. */
  title: string
  /** One line on what it asks for, for the builder. */
  description: string
  /** The options of a definition this kind takes. */
  options: readonly InputOption[]
  /** The rules this kind takes. */
  rules: readonly InputRule[]
  /** What it picks from, when it picks: a list of values, or the entities of a blueprint. Its length rules then count the picks of a list. */
  picks?: 'values' | 'entity'
  /** The entity it picks is a person: one of the blueprint the estate says a person is, so the definition names none. */
  person?: true
  /** What `min` and `max` are read as. */
  bounds?: 'number' | 'day' | 'instant'
  /** How the builder asks for a default: as text, as a number, as a switch, or not at all. */
  defaultAs: 'text' | 'number' | 'toggle' | 'none'
  /** How a page shows a stored value: as it reads, with its line breaks, as Markdown, as a moment in the reader's own time, as the entity it names, or folded until the reader opens it. */
  shows: 'value' | 'lines' | 'prose' | 'instant' | 'entity' | 'attachment'
  /**
   * One value checked, its rules included: the value as it is stored, or the
   * reason it is refused. The same in the browser and in the hub. Whether an
   * entity exists and may be picked is the hub's to say afterwards.
   */
  check(def: InputRules, value: unknown, ctx: CheckContext): Checked
  /** True when nothing was given. */
  empty(value: unknown): boolean
  /** One stored value as a person reads it. */
  text(value: unknown): string
}

/** A pattern longer than this is refused when the action is saved. */
export const PATTERN_MAX = 200
/** A value longer than this is refused by an input with a pattern: the match is never run on more. */
export const PATTERN_VALUE_MAX = 1000

const ok = (value: unknown): Checked => ({ ok: true, value })
const no = (error: string): Checked => ({ ok: false, error })

const blank = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
const plain = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:\d{2})$/
const RELATIVE = /^today(?:([+-])(\d{1,3})([dwmy]))?$/
const DAY_MS = 86_400_000

/** The start of a day in UTC, or null when the text is not a real day: February has no 30th. */
function dayMs(text: string): number | null {
  const m = DAY.exec(text)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(0)
  at.setUTCFullYear(y, mo - 1, d)
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d ? at.getTime() : null
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** A moment written with an offset, or null: a real day, a real time, and where it was said from. */
function instantMs(text: string): number | null {
  const m = INSTANT.exec(text)
  if (!m || dayMs(m[1]!) === null || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null
  const offset = m[6]!.toUpperCase()
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}.${(m[5] ?? '0').padEnd(3, '0').slice(0, 3)}${offset}`)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The day a bound names, as YYYY-MM-DD: a day as it is, or `today` moved by
 * days, weeks, months, or years (`today+30d`, `today-2w`, `today+1m`,
 * `today-1y`) from the UTC day given. A month or a year lands on the same
 * day of the month, or on the month's last when it has no such day. Null
 * for anything else.
 */
export function resolveDay(bound: string, today: string): string | null {
  if (dayMs(bound) !== null) return bound
  const m = RELATIVE.exec(bound)
  const from = dayMs(today)
  if (!m || from === null) return null
  if (!m[1]) return today
  const n = (m[1] === '-' ? -1 : 1) * Number(m[2])
  const at = new Date(from)
  if (m[3] === 'd' || m[3] === 'w') at.setUTCDate(at.getUTCDate() + n * (m[3] === 'w' ? 7 : 1))
  else {
    const day = at.getUTCDate()
    at.setUTCDate(1)
    at.setUTCMonth(at.getUTCMonth() + n * (m[3] === 'y' ? 12 : 1))
    at.setUTCDate(Math.min(day, new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate()))
  }
  return dayOf(at.getTime())
}

/** A bound as a number to compare with, or null when it is not a bound of that sort. A day bounds an instant from its start, or as `max`, to its end. */
function boundOf(bounds: NonNullable<InputKind['bounds']>, bound: number | string, today: string, end: boolean): number | null {
  if (bounds === 'number') return typeof bound === 'number' && Number.isFinite(bound) ? bound : null
  if (typeof bound !== 'string') return null
  const day = resolveDay(bound, today)
  if (day !== null) return dayMs(day)! + (bounds === 'instant' && end ? DAY_MS - 1 : 0)
  return bounds === 'instant' ? instantMs(bound) : null
}

/** A checked value as a number to hold against a bound. */
function measured(bounds: NonNullable<InputKind['bounds']>, value: unknown): number | null {
  if (bounds === 'number') return typeof value === 'number' ? value : null
  if (typeof value !== 'string') return null
  return bounds === 'day' ? dayMs(value) : instantMs(value)
}

const boundText = (bounds: NonNullable<InputKind['bounds']>, n: number): string => (bounds === 'number' ? String(n) : bounds === 'day' ? dayOf(n) : new Date(n).toISOString())

/**
 * True when a group that repeats without limit holds a repeat without limit,
 * as `(a+)+` does: the shape that makes a match take forever on a value that
 * nearly fits. It is the common trap and the only one looked for.
 */
function nestedRepeat(pattern: string): boolean {
  const unbounded = (i: number) => pattern[i] === '*' || pattern[i] === '+' || /^\{\d+,\}/.test(pattern.slice(i, i + 12))
  // For each group still open, whether a repeat without limit was seen inside it.
  const open: boolean[] = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '(') open.push(false)
    else if (c === ')') {
      const held = open.pop() ?? false
      const repeats = unbounded(i + 1)
      if (held && repeats) return true
      if ((held || repeats) && open.length) open[open.length - 1] = true
    } else if (unbounded(i) && open.length) open[open.length - 1] = true
  }
  return false
}

const whole = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`, 'u')
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** The rules of a definition held against one checked value: the first that fails, in the hint's words when there is one. */
function ruled(kind: InputKind, def: InputRules, value: unknown, ctx: CheckContext): Checked {
  const fails = (error: string): Checked => no(def.hint ?? error)
  if (typeof value === 'string' && !kind.picks) {
    const length = [...value].length
    if (def.minLength !== undefined && kind.rules.includes('minLength') && length < def.minLength) return fails(`expected at least ${count(def.minLength, 'character')}`)
    if (def.maxLength !== undefined && kind.rules.includes('maxLength') && length > def.maxLength) return fails(`expected at most ${count(def.maxLength, 'character')}`)
    if (def.pattern !== undefined && kind.rules.includes('pattern')) {
      if (length > PATTERN_VALUE_MAX) return no(`expected at most ${PATTERN_VALUE_MAX} characters: more are not checked against a pattern`)
      if (!whole(def.pattern).test(value)) return fails(`expected text that matches ${def.pattern}`)
    }
  }
  if (kind.bounds) {
    const n = measured(kind.bounds, value)
    const [least, most] = kind.bounds === 'number' ? ['more', 'less'] : ['later', 'earlier']
    const min = def.min === undefined ? null : boundOf(kind.bounds, def.min, ctx.today, false)
    const max = def.max === undefined ? null : boundOf(kind.bounds, def.max, ctx.today, true)
    if (n !== null && min !== null && n < min) return fails(`expected ${boundText(kind.bounds, min)} or ${least}`)
    if (n !== null && max !== null && n > max) return fails(`expected ${boundText(kind.bounds, max)} or ${most}`)
  }
  return ok(value)
}

/** A kind whose `check` is its own check of the shape, then the rules it takes. */
function kind(spec: Omit<InputKind, 'check'> & { shape: (value: unknown, ctx: CheckContext) => Checked }): InputKind {
  const { shape, ...rest } = spec
  const made: InputKind = {
    ...rest,
    check(def, value, ctx) {
      const shaped = shape(value, ctx)
      return shaped.ok ? ruled(made, def, shaped.value, ctx) : shaped
    },
  }
  return made
}

const textShape = (value: unknown): Checked => (typeof value === 'string' ? ok(value) : no('expected text'))

/** The most characters an attachment holds, whatever its own rules say. */
export const ATTACHMENT_MAX = 1_000_000

const attachmentShape = (value: unknown): Checked => {
  if (typeof value !== 'string') return no('expected text')
  return value.length > ATTACHMENT_MAX ? no(`expected at most ${ATTACHMENT_MAX.toLocaleString('en-US')} characters`) : ok(value)
}

/** An entity's id from what was given: an id as it is, a bare key as the key of the one blueprint picked from, an entity or a list of them as its first. */
function entityShape(value: unknown, ctx: CheckContext): Checked {
  const picks = ctx.picks ?? []
  const first: unknown = Array.isArray(value) ? value[0] : value
  const given = first && typeof first === 'object' && 'id' in first ? (first as { id: unknown }).id : first
  const id = typeof given !== 'string' || given === '' ? null : given.includes(':') || picks.length !== 1 ? given : `${picks[0]}:${given}`
  const colon = id ? id.indexOf(':') : -1
  if (!id || colon <= 0 || colon === id.length - 1) return no('expected an entity id, blueprint:key')
  if (ctx.picks && !picks.includes(id.slice(0, colon))) return no(`expected ${picks.length === 1 ? `a ${picks[0]}` : `one of ${picks.join(', ')}`}`)
  return ok(id)
}

const KINDS = {
  string: kind({
    title: 'Short text',
    description: 'One line of text.',
    options: ['many', 'narrows', 'unique', 'current'],
    rules: ['pattern', 'minLength', 'maxLength'],
    defaultAs: 'text',
    shows: 'value',
    shape: textShape,
    empty: blank,
    text: plain,
  }),
  text: kind({
    title: 'Long text',
    description: 'Several lines of plain text, kept with their line breaks.',
    options: [],
    rules: ['pattern', 'minLength', 'maxLength'],
    defaultAs: 'text',
    shows: 'lines',
    shape: textShape,
    empty: blank,
    text: plain,
  }),
  markdown: kind({
    title: 'Markdown',
    description: 'Long text written as Markdown, shown formatted on the run.',
    options: ['narrows'],
    rules: ['minLength', 'maxLength'],
    defaultAs: 'text',
    shows: 'prose',
    shape: textShape,
    empty: blank,
    text: plain,
  }),
  attachment: kind({
    title: 'Attachment',
    description: 'A long text kept exactly as it was sent, such as a plan or a report: folded on the run until a reader opens it.',
    options: [],
    rules: ['maxLength'],
    defaultAs: 'none',
    shows: 'attachment',
    shape: attachmentShape,
    empty: blank,
    text: plain,
  }),
  number: kind({
    title: 'Number',
    description: 'A number, whole or not.',
    options: ['many', 'narrows', 'unique', 'current'],
    rules: ['min', 'max'],
    bounds: 'number',
    defaultAs: 'number',
    shows: 'value',
    shape(value) {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      return Number.isFinite(n) ? ok(n) : no('expected a number')
    },
    empty: blank,
    text: plain,
  }),
  boolean: kind({
    title: 'Yes or no',
    description: 'A switch: on or off.',
    options: ['narrows'],
    rules: [],
    defaultAs: 'toggle',
    shows: 'value',
    shape(value) {
      const b = typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null
      return b === null ? no('expected true or false') : ok(b)
    },
    empty: blank,
    text: (value) => (value === true ? 'Yes' : value === false ? 'No' : plain(value)),
  }),
  date: kind({
    title: 'Date',
    description: 'A day, picked from a calendar and kept as YYYY-MM-DD.',
    options: ['narrows'],
    rules: ['min', 'max'],
    bounds: 'day',
    defaultAs: 'text',
    shows: 'value',
    shape(value) {
      const day = typeof value === 'string' ? value.trim() : ''
      return dayMs(day) === null ? no('expected a date, as YYYY-MM-DD') : ok(day)
    },
    empty: blank,
    text: plain,
  }),
  datetime: kind({
    title: 'Date and time',
    description: 'A moment, asked for in the person\'s own time and kept in UTC.',
    options: [],
    rules: ['min', 'max'],
    bounds: 'instant',
    defaultAs: 'text',
    shows: 'instant',
    shape(value) {
      const ms = typeof value === 'string' ? instantMs(value.trim()) : null
      return ms === null ? no('expected a date and time with an offset, as 2026-03-10T14:30:00Z') : ok(new Date(ms).toISOString())
    },
    empty: blank,
    text: plain,
  }),
  email: kind({
    title: 'Email address',
    description: 'One email address. Its shape is checked; nobody is written to.',
    options: ['many', 'narrows', 'unique', 'current'],
    rules: ['pattern'],
    defaultAs: 'text',
    shows: 'value',
    shape(value) {
      const address = typeof value === 'string' ? value.trim() : ''
      const at = address.lastIndexOf('@')
      if (address.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address)) return no('expected an email address')
      return ok(address.slice(0, at) + address.slice(at).toLowerCase())
    },
    empty: blank,
    text: plain,
  }),
  url: kind({
    title: 'Link',
    description: 'A web address, such as https://example.com.',
    options: ['many', 'narrows', 'unique', 'current'],
    rules: ['pattern'],
    defaultAs: 'text',
    shows: 'value',
    shape: (value) => (typeof value === 'string' && URL.canParse(value) ? ok(value) : no('expected a URL')),
    empty: blank,
    text: plain,
  }),
  enum: kind({
    title: 'Choice',
    description: 'One of a list of values, or several of them.',
    options: ['many', 'values', 'display', 'narrows'],
    rules: ['minLength', 'maxLength'],
    picks: 'values',
    defaultAs: 'text',
    shows: 'value',
    shape(value, ctx) {
      const allowed = ctx.allowed ?? []
      return typeof value === 'string' && allowed.includes(value) ? ok(value) : no(allowed.length ? `expected one of ${allowed.join(', ')}` : 'no values to pick from')
    },
    empty: blank,
    text: plain,
  }),
  entity: kind({
    title: 'Entity',
    description: 'One entity of a blueprint, or several, picked from the catalog.',
    options: ['many', 'blueprint', 'where', 'sort', 'current', 'narrows', 'show'],
    rules: ['minLength', 'maxLength'],
    picks: 'entity',
    defaultAs: 'none',
    shows: 'entity',
    shape: entityShape,
    empty: blank,
    text: plain,
  }),
  person: kind({
    title: 'Person',
    description: 'One person, or several, picked from the blueprint the estate says a person is.',
    options: ['many', 'where', 'sort', 'current', 'narrows', 'show'],
    rules: ['minLength', 'maxLength'],
    picks: 'entity',
    person: true,
    defaultAs: 'none',
    shows: 'entity',
    shape: entityShape,
    empty: blank,
    text: plain,
  }),
} satisfies Record<string, InputKind>

export type InputKindName = keyof typeof KINDS

/** Every kind of input, in the order the builder offers them. */
export const INPUT_KINDS: Record<InputKindName, InputKind> = KINDS

/** The names of the inputs that are attachments: long texts a run keeps for its own page, never copied into a list of runs, an activity row, or a notice. */
export function attachedInputs(inputs: Record<string, { type: InputKindName }> | undefined): string[] {
  return Object.entries(inputs ?? {}).flatMap(([name, def]) => (INPUT_KINDS[def.type]?.shows === 'attachment' ? [name] : []))
}

/** These inputs with each attachment's text left out, said in its place by its length. */
export function withoutAttached(defs: Record<string, { type: InputKindName }> | undefined, inputs: Record<string, unknown>): Record<string, unknown> {
  const out = { ...inputs }
  for (const name of attachedInputs(defs)) {
    const value = out[name]
    if (typeof value === 'string') out[name] = `attached: ${value.length} characters`
  }
  return out
}

/**
 * The kind a definition names. A name this release does not know, as a page
 * or a hub one release back may meet, is read as short text: the newer side
 * checks it.
 */
export function kindOf(type: string): InputKind {
  return (KINDS as Record<string, InputKind>)[type] ?? KINDS.string
}

/** What the checks and the text of a whole input read of its definition. */
export interface InputShape extends InputRules {
  type: InputKindName
  many?: boolean
}

/** A list as it was given: a list, or text with one value a line. Null for anything else. */
export function listOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value.split('\n').map((l) => l.trim()).filter(Boolean) : null
}

/** What is wrong with how many were picked, for a list that picks, or null. */
export function countError(def: InputShape, picked: number): string | null {
  if (!kindOf(def.type).picks || !def.many) return null
  if (def.minLength !== undefined && picked < def.minLength) return def.hint ?? `expected at least ${def.minLength} picked`
  if (def.maxLength !== undefined && picked > def.maxLength) return def.hint ?? `expected at most ${def.maxLength} picked`
  return null
}

/**
 * What is wrong with a list a person types, for a kind that does not pick:
 * a value given twice, named as it is stored. Null when each is there once.
 */
export function twiceIn(def: Pick<InputShape, 'type'>, stored: readonly unknown[]): string | null {
  const kind = kindOf(def.type)
  if (kind.picks) return null
  const seen = new Set<string>()
  for (const value of stored) {
    const key = JSON.stringify(value)
    if (seen.has(key)) return `expected each value once: ${kind.text(value)} is in the list twice`
    seen.add(key)
  }
  return null
}

/**
 * A whole input checked: one value by its kind, or for a `many` input each
 * item by its kind and then how many there are. What the hub must add, such
 * as whether an entity exists, it adds item by item with the same pieces.
 */
export function checkInput(def: InputShape, value: unknown, ctx: CheckContext): Checked {
  const kind = kindOf(def.type)
  if (!def.many) return kind.check(def, value, ctx)
  const items = listOf(value)
  if (!items) return no('expected a list')
  const stored: unknown[] = []
  for (const item of items) {
    const one = kind.check(def, item, ctx)
    if (!one.ok) return one
    stored.push(one.value)
  }
  const error = twiceIn(def, stored) ?? countError(def, stored.length)
  return error === null ? ok(stored) : no(error)
}

/** True when an input was given nothing. */
export function inputEmpty(def: Pick<InputShape, 'type'>, value: unknown): boolean {
  return kindOf(def.type).empty(value)
}

/** A stored input as a person reads it: nothing as nothing, a list item by item. */
export function inputText(def: Pick<InputShape, 'type' | 'many'>, value: unknown): string {
  const kind = kindOf(def.type)
  if (kind.empty(value)) return ''
  return Array.isArray(value) ? value.map((v) => kind.text(v)).join(', ') : kind.text(value)
}

/** One thing wrong with a definition, at the option or rule it is about. */
export interface DefIssue {
  at: InputRule | 'hint' | 'many' | 'display' | 'narrows' | 'unique' | 'show' | 'current'
  message: string
}

const DAY_FORMS = 'a day, as YYYY-MM-DD, or today, today+30d, today-1y'
const BOUND_FORMS = { number: 'a number', day: DAY_FORMS, instant: `an instant with an offset, as 2026-03-10T14:30:00Z, or ${DAY_FORMS}` } as const
/** Any day: where `today` stands when two bounds that both read it are held against each other. */
const SOME_DAY = '2001-01-01'

/** A kind named in a sentence. */
export const aKind = (type: string): string => `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} input`

/**
 * What is wrong with the options and rules of a definition for its kind: an
 * option or a rule the kind does not take, a pattern that does not compile
 * or could take forever, a bound that is not one, and a floor past its
 * ceiling. It needs nothing but the definition.
 */
export function defIssues(type: InputKindName, def: InputRules & { many?: boolean; display?: string; narrows?: string; unique?: unknown; show?: unknown; current?: unknown }): DefIssue[] {
  const kind = INPUT_KINDS[type]
  const issues: DefIssue[] = []
  if (def.many && !kind.options.includes('many')) issues.push({ at: 'many', message: `${aKind(type)} is one value` })
  if (def.display !== undefined && !kind.options.includes('display')) issues.push({ at: 'display', message: `${aKind(type)} has no display` })
  if (def.narrows !== undefined && !kind.options.includes('narrows')) issues.push({ at: 'narrows', message: `${aKind(type)} cannot narrow what the action runs on` })
  if (def.unique !== undefined && !kind.options.includes('unique')) issues.push({ at: 'unique', message: `${aKind(type)} has no value to hold unique` })
  else if (def.unique !== undefined && def.many) issues.push({ at: 'unique', message: 'unique holds one value, and the input takes a list' })
  if (def.current !== undefined && !kind.options.includes('current')) issues.push({ at: 'current', message: `${aKind(type)} has no current` })
  else if (def.current !== undefined && !kind.picks && !def.many) issues.push({ at: 'current', message: `current is the list the entity holds now, so the input needs many: true` })
  if (def.show !== undefined && !kind.options.includes('show')) issues.push({ at: 'show', message: `${aKind(type)} has no options to show fields of` })
  const given = INPUT_RULES.filter((rule) => def[rule] !== undefined)
  for (const rule of given) if (!kind.rules.includes(rule)) issues.push({ at: rule, message: `${aKind(type)} takes no ${rule}` })
  const takes = (rule: InputRule) => def[rule] !== undefined && kind.rules.includes(rule)
  if (takes('pattern')) {
    const pattern = def.pattern!
    if (pattern.length > PATTERN_MAX) issues.push({ at: 'pattern', message: `the pattern is longer than ${PATTERN_MAX} characters` })
    else {
      try {
        whole(pattern)
        if (nestedRepeat(pattern)) issues.push({ at: 'pattern', message: 'the pattern holds a repeat inside a repeat, which can take forever to match: write it without one' })
      } catch (error) {
        issues.push({ at: 'pattern', message: `the pattern does not compile: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }
  if (kind.bounds) {
    const min = takes('min') ? boundOf(kind.bounds, def.min!, SOME_DAY, false) : null
    const max = takes('max') ? boundOf(kind.bounds, def.max!, SOME_DAY, true) : null
    if (takes('min') && min === null) issues.push({ at: 'min', message: `min must be ${BOUND_FORMS[kind.bounds]}` })
    if (takes('max') && max === null) issues.push({ at: 'max', message: `max must be ${BOUND_FORMS[kind.bounds]}` })
    // Two bounds are held against each other only when both read today, or neither does.
    const moves = (bound: unknown) => typeof bound === 'string' && bound.startsWith('today')
    if (min !== null && max !== null && moves(def.min) === moves(def.max) && min > max) issues.push({ at: 'min', message: 'min is past max' })
  }
  for (const rule of ['minLength', 'maxLength'] as const) if (takes(rule) && kind.picks && !def.many) issues.push({ at: rule, message: `${rule} counts what is picked, so the input needs many: true` })
  if (takes('minLength') && takes('maxLength') && def.minLength! > def.maxLength!) issues.push({ at: 'minLength', message: 'minLength is past maxLength' })
  if (def.hint !== undefined && !given.length && def.unique === undefined) issues.push({ at: 'hint', message: 'a hint says what a failed rule means, and the input has no rule' })
  return issues
}
