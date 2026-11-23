// What the conditions of a filter are called, and which tests each kind of
// field offers. `components/Clauses.tsx` draws them; this file only decides.

import type { GridClause, RelationMatch } from '../shared/api.ts'
import { reachedBy } from '../shared/clauses.ts'
import { currencyText, formatCurrency } from '../shared/currency.ts'
import { STATUS_LEVELS, type Blueprint, type CurrencyFormat, type FieldDef, type FieldType, type ValueColor } from '../shared/model.ts'

type Op = GridClause['op']

/** A value a condition may pick: what it compares, what a person reads, and, where known, how many rows hold it and its colour. */
export interface Choice {
  value: string
  label: string
  count?: number
  color?: ValueColor
}

/** What a relation reaches, for the conditions a person sets on it: what those entities are called, and the fields a condition on them may test. */
export interface Reach {
  title: string
  fields: readonly ConditionField[]
}

/** A field a condition may test. */
export interface ConditionField {
  id: string
  title: string
  type?: FieldType
  /** Its definition, where it has one, for the glyph of its kind. */
  def?: Pick<FieldDef, 'type' | 'mirror' | 'aggregation' | 'calculation' | 'format'>
  /** On a relation: what it reaches, so a condition may test their fields. */
  reaches?: Reach
  /** The values a condition on it picks from, where the field says them itself: an enum's, a boolean's, a status. */
  choices?: Choice[]
}

/** One test a condition makes: an op, turned round where `not` says so; on a relation, how many of what it reaches must meet conditions of their own. */
export interface Test {
  op: Op
  not?: boolean
  match?: RelationMatch
}

/** The tests that have a turned-round form a person picks. `eq` has `neq` for that. */
const TURNS: ReadonlySet<Op> = new Set(['contains', 'prefix', 'exists'])

/** The tests a condition may make with these ops: each op, and the turned-round form of those that have one; on a relation that says what it reaches, any, every, and none of them. */
export function testsOf(ops: readonly Op[], reaches?: Reach): Test[] {
  const own = ops.flatMap((op): Test[] => (TURNS.has(op) ? [{ op }, { op, not: true }] : [{ op }]))
  return reaches ? [...own, ...MATCHES.map((match): Test => ({ op: 'exists', match }))] : own
}

/** How many of what a relation reaches a condition may ask about, in the order offered. */
const MATCHES: readonly RelationMatch[] = ['any', 'all', 'none']

export function sameTest(a: Test, b: Test): boolean {
  return a.op === b.op && !a.not === !b.not && a.match === b.match
}

/** A test that asks for no value: whether it is set, or a test of what a relation reaches, which holds conditions instead. */
export function valueless(t: Test): boolean {
  return t.op === 'exists'
}

/** The test a condition makes, as `Test`. */
export function testOf(c: GridClause): Test {
  return { op: c.op, ...(c.not ? { not: true } : {}), ...(c.where ? { match: c.match ?? 'any' } : {}) }
}

/** What a test of what a relation reaches says before its conditions: "any Repository", "every Repository", "no Team". */
export function matchWords(match: RelationMatch, title: string): string {
  return match === 'all' ? `every ${title}` : match === 'none' ? `no ${title}` : `any ${title}`
}

/** The fields of a blueprint a condition may test, as the grid names them: the status, its fields, and its relations, each relation with what it reaches to `depth` hops. */
export function conditionFields(bp: Pick<Blueprint, 'id' | 'fields' | 'relations'>, blueprints: readonly Blueprint[], name: (bp: Blueprint) => string, depth = 2): ConditionField[] {
  return [
    { id: '$status', title: 'Status', type: 'enum', choices: STATUS_LEVELS.map((v) => ({ value: v, label: v })) },
    ...Object.entries(bp.fields).map(([id, def]): ConditionField => {
      const values = def.type === 'enum' ? (def.values ?? []) : def.type === 'boolean' ? ['true', 'false'] : null
      return { id, title: def.title ?? id, type: def.type, def, ...(values ? { choices: values.map((v) => ({ value: v, label: v, ...(def.colors?.[v] ? { color: def.colors[v] } : {}) })) } : {}) }
    }),
    ...Object.entries(bp.relations).map(([id, def]): ConditionField => {
      const reaches = depth > 0 ? reachOf(bp, `r:${id}`, blueprints, name, depth - 1) : undefined
      return { id: `r:${id}`, title: def.title ?? id, ...(reaches ? { reaches } : {}) }
    }),
  ]
}

/** What a relation column reaches, for a condition on it, or undefined when its blueprint is not one the reader has. */
export function reachOf(bp: Pick<Blueprint, 'relations'>, field: string, blueprints: readonly Blueprint[], name: (bp: Blueprint) => string, depth = 1): Reach | undefined {
  if (!field.startsWith('r:')) return undefined
  const find = (id: string) => blueprints.find((b) => b.id === id)
  const end = reachedBy(bp, field.slice(2), find)
  const full = end && find(end.id)
  return full ? { title: name(full), fields: conditionFields(full, blueprints, name, depth) } : undefined
}

/** The ops a condition on a field of this kind offers, the most asked first. A relation compares its target, or asks whether it is set. */
export function opsFor(type: FieldType | undefined, relation: boolean, picks: boolean): Op[] {
  if (relation) return ['eq', 'neq', 'exists']
  if (type === 'array') return ['contains', 'exists']
  if (type === 'number') return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists']
  if (type === 'datetime') return ['within', 'older', 'gt', 'lt', 'exists']
  if (type === 'boolean' || type === 'enum' || picks) return ['eq', 'neq', 'exists']
  return ['contains', 'eq', 'neq', 'prefix', 'exists']
}

/** The test a new condition starts with: the first its field offers. */
export function firstTest(ops: readonly Op[]): Test {
  return { op: ops[0] ?? 'eq' }
}

/** What a test is called, as a person reads it between a field and a value. A list includes a value; a time is within a span. */
export function testWords(t: Test, type?: FieldType): string {
  const list = type === 'array'
  switch (t.op) {
    case 'eq':
      return 'is'
    case 'neq':
      return 'is not'
    case 'contains':
      return list ? (t.not ? 'does not include' : 'includes') : t.not ? 'does not contain' : 'contains'
    case 'prefix':
      return t.not ? 'does not start with' : 'starts with'
    case 'exists':
      return t.not ? 'is empty' : 'is set'
    case 'gt':
      return type === 'datetime' ? 'is after' : 'is above'
    case 'gte':
      return 'is at least'
    case 'lt':
      return type === 'datetime' ? 'is before' : 'is below'
    case 'lte':
      return 'is at most'
    case 'within':
      return 'is within the last'
    case 'older':
      return 'is older than'
    case 'in':
      return 'is one of'
  }
}

/** What to show in an empty value box for a test. */
export function hintFor(t: Test, type?: FieldType, money?: CurrencyFormat): string {
  if (t.op === 'within' || t.op === 'older') return 'A span, such as 30d or 12h'
  if (type === 'datetime') return 'A date, such as 2026-01-31'
  if (money) return `An amount in ${money.currency}, such as 1,250.00`
  if (type === 'number') return 'A number'
  return 'Type a value'
}

/**
 * A condition's value as a person reads and types it: an amount where its
 * field is shown as money, else the value as stored. A condition always keeps
 * the stored number, so it means the same in the text form and on the hub.
 */
export function valueShown(c: Pick<GridClause, 'op' | 'value'>, money: CurrencyFormat | undefined, as: 'typed' | 'said' = 'typed'): string {
  if (!money || c.op === 'exists' || c.value.trim() === '' || !Number.isFinite(Number(c.value))) return c.value
  return as === 'said' ? formatCurrency(Number(c.value), money) : currencyText(Number(c.value), money)
}

/** A condition said as a sentence: "Connection is online", "Homed in: any Repository where Days idle is above 90". */
export function sentence(c: GridClause, field: string, value: string, type?: FieldType, reach?: Reach): string {
  if (c.where) return `${field}: ${reachSentence(c, reach)}`
  const words = testWords(c, type)
  return valueless(c) ? `${field} ${words}` : `${field} ${words} ${value}`
}

/** What a condition on a relation's reach says after the relation: "any Repository where Days idle is above 90 and Status is red". */
export function reachSentence(c: GridClause, reach?: Reach): string {
  const head = matchWords(c.match ?? 'any', reach?.title ?? 'entity')
  const inner = (c.where ?? []).filter((x) => x.field).map((x) => {
    const f = reach?.fields.find((r) => r.id === x.field)
    const label = f?.choices?.find((v) => v.value === x.value)?.label ?? x.value
    return sentence(x, f?.title ?? x.field, label, f?.type, f?.reaches)
  })
  return inner.length ? `${head} where ${inner.join(' and ')}` : head
}
