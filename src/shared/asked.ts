// Which inputs of an action's form are asked, and what a worked-out one
// holds. The hub decides with these at every request; the form, the review,
// and the run's page read the same answer, so what a person is shown is what
// the hub will keep.

import { compile, type Expr } from './expr.ts'
import { matches } from './filter.ts'
import { inputEmpty } from './input-kinds.ts'
import type { Action, ActionInputDef, Entity, Filter } from './model.ts'

/** What an input holds for the ones below it: its value, or null when it holds nothing. */
function held(value: unknown): unknown {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) ? null : value
}

/**
 * The inputs given so far as the record a `when` is judged over: each a field
 * by its own name. Every input before it is there, so a name the hub also
 * keeps of an entity, such as `title`, reads the input and never that.
 */
function record(before: Record<string, unknown>): Entity {
  const fields = Object.fromEntries(Object.entries(before).map(([name, value]) => [name, held(value)]))
  return { blueprint: '', key: '', id: '', title: '', icon: null, state: 'active', hidden: false, fields, relations: {}, owner: '', scope: null, createdAt: '', updatedAt: '', lastSeenAt: null, missingSince: null, deletedAt: null, status: { level: 'grey', reasons: [] } }
}

/**
 * Whether an input is asked: it has no `when`, or its `when` matches the
 * inputs before it. `before` holds every input declared above it by name, as
 * checked, with nothing for one that was empty or not asked itself. An input
 * `when` names that is not there reads as unset.
 */
export function isAsked(def: Pick<ActionInputDef, 'when'>, before: Record<string, unknown>): boolean {
  if (!def.when) return true
  const reads = whenReads(def.when)
  // A name not among the inputs before it must read as unset, never as what the hub keeps of an entity.
  const known = { ...Object.fromEntries(reads.fields.map((name) => [name, null])), ...before }
  return matches(record(known), def.when)
}

/**
 * The inputs a `when` reads, and why it is refused when it tests anything
 * else: a `when` holds only tests of inputs, and none that reads the time,
 * so which inputs a run was asked never moves after it.
 */
export function whenReads(f: Filter): { fields: string[]; refused: string | null } {
  const fields = new Set<string>()
  let refused: string | null = null
  const walk = (f: Filter): void => {
    if ('and' in f) return f.and.forEach(walk)
    if ('or' in f) return f.or.forEach(walk)
    if ('not' in f) return walk(f.not)
    if (!('field' in f) || typeof f.field !== 'string') {
      refused ??= `a when tests only the inputs given, as { field, op, value }: it cannot test ${Object.keys(f)[0] ?? 'nothing'}`
      return
    }
    if (f.op === 'within' || f.op === 'older') refused ??= `a when cannot read the time, and ${f.op} does`
    fields.add(f.field)
  }
  walk(f)
  return { fields: [...fields], refused }
}

const COMPILED = new Map<string, Expr | null>()
const COMPILED_MAX = 500

/** The expression of a worked-out input, parsed once. Null when it does not compile. */
function compiled(source: string): Expr | null {
  const hit = COMPILED.get(source)
  if (hit !== undefined) return hit
  let expr: Expr | null
  try {
    expr = compile(source)
  } catch {
    expr = null
  }
  if (COMPILED.size >= COMPILED_MAX) COMPILED.clear()
  COMPILED.set(source, expr)
  return expr
}

/**
 * What a worked-out input holds: its expression over the inputs before it,
 * by name. Null when the expression does not compile or gives nothing.
 */
export function workedOut(def: Pick<ActionInputDef, 'value'>, before: Record<string, unknown>): unknown {
  const expr = def.value === undefined ? null : compiled(def.value)
  if (!expr) return null
  try {
    return held(expr.evaluate(Object.fromEntries(Object.entries(before).map(([name, value]) => [name, held(value)]))))
  } catch {
    return null
  }
}

/** The inputs in play for what was given, and what each holds. */
export interface Asked {
  /** The inputs that are asked or worked out, in declared order. Every other input is not asked. */
  asked: string[]
  /** What every input holds: what was given, what was worked out, or null when it is empty or not asked. */
  values: Record<string, unknown>
}

/**
 * Which inputs are asked for what was given, in declared order: each is
 * judged over the ones before it that were themselves asked. An input not
 * asked holds nothing, whatever was given for it. A worked-out input holds
 * what its expression gives, whatever was given for it; with `stored`, what
 * was given is a run as the hub stored it, and its worked-out values are
 * kept as they were.
 */
export function askedInputs(inputs: Record<string, ActionInputDef>, given: Record<string, unknown>, opts: { stored?: boolean } = {}): Asked {
  const asked: string[] = []
  const values: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(inputs)) {
    if (!isAsked(def, values)) {
      values[name] = null
      continue
    }
    asked.push(name)
    values[name] = def.value !== undefined && !opts.stored ? workedOut(def, values) : inputEmpty(def, given[name]) ? null : given[name]
  }
  return { asked, values }
}

/** One group of a form's inputs: under a heading, or the last one, which has none. */
export interface FormSection {
  title?: string
  description?: string
  inputs: string[]
}

/**
 * The groups a form draws for the inputs it asks: each of the action's
 * sections with the asked inputs it names, in the section's order, then
 * every asked input no section names, under no heading. A section left
 * holding no asked input is not there.
 */
export function formSections(action: Pick<Action, 'inputs' | 'sections'>, asked: readonly string[]): FormSection[] {
  const named = new Set((action.sections ?? []).flatMap((s) => s.inputs))
  const groups: FormSection[] = (action.sections ?? []).map((s) => ({ title: s.title, ...(s.description ? { description: s.description } : {}), inputs: s.inputs.filter((n) => asked.includes(n)) }))
  groups.push({ inputs: Object.keys(action.inputs).filter((n) => !named.has(n) && asked.includes(n)) })
  return groups.filter((g) => g.inputs.length > 0)
}
