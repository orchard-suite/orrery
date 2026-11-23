// A filter as the conditions a person edits: tests of a field, each of which
// must hold. The grid's filter bar, the action builder's "Ask only when",
// and a saved query keep their conditions in this shape, and turn them into a
// filter here, in the browser and on the hub alike.

import { clauseRelation, type GridClause, type RelationMatch } from './api.ts'
import { parsePath, stable } from './filter.ts'
import { FILTER_OPS, type Blueprint, type FieldDef, type FieldType, type Filter } from './model.ts'

/**
 * What kind of value a field holds, by the name a condition gives it;
 * undefined where nothing says. `through` gives the same for the blueprint a
 * relation reaches, for the conditions a relation's `where` holds.
 */
export type TypeOf = ((field: string) => FieldType | undefined) & { through?: (relation: string) => TypeOf | undefined }

/** The kinds of field that hold text, whose value is never read as a number or a boolean. */
const TEXT: ReadonlySet<FieldType> = new Set(['string', 'enum', 'url', 'markdown', 'email', 'user'])
/** What the hub keeps of every entity that is text. */
const TEXT_META: ReadonlySet<string> = new Set(['$key', '$title', '$icon', '$blueprint', '$state', '$owner', '$status'])

/** What kind of value each of a blueprint's fields holds, and the text the hub keeps of every entity. */
export function typesOf(fields: Readonly<Record<string, Pick<FieldDef, 'type'>>>): TypeOf {
  return (field) => (TEXT_META.has(field) ? 'string' : fields[field]?.type)
}

/** What a blueprint's model holds that a condition reads: its fields, and where its relations lead. */
type Shape = Pick<Blueprint, 'id' | 'fields' | 'relations'>

/** The blueprint a relation of one reaches: its own relation's target, or, coming in (`<-bp:rel`), the blueprint named. Undefined when it cannot be told. */
export function reachedBy(bp: Pick<Blueprint, 'relations'>, relation: string, find: (id: string) => Shape | undefined): Shape | undefined {
  let hops
  try {
    hops = parsePath(relation)
  } catch {
    return undefined
  }
  if (hops.length !== 1) return undefined
  const hop = hops[0]!
  if (hop.incoming) return hop.from ? find(hop.from) : undefined
  const target = bp.relations[hop.relation]?.target
  return target ? find(target) : undefined
}

/** What kind of value each of a blueprint's fields holds, as `typesOf`, and through each relation, the fields of the blueprint it reaches. */
export function typesIn(bp: Pick<Blueprint, 'fields' | 'relations'>, find: (id: string) => Shape | undefined): TypeOf {
  const own = typesOf(bp.fields)
  const typed: TypeOf = (field) => own(field)
  typed.through = (relation) => {
    const end = reachedBy(bp, relation, find)
    return end ? typesIn(end, find) : undefined
  }
  return typed
}

/** What was typed as a condition's value: a number or a boolean when it looks like one. */
export function parseValue(v: string): unknown {
  const t = v.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return v
}

/** One test as a condition, or null when a condition cannot hold it: a list to be among, or a text that would come back as something else. */
function clauseOf(test: unknown): GridClause | null {
  if (!test || typeof test !== 'object' || Array.isArray(test)) return null
  const { field, op, value, ...rest } = test as Record<string, unknown>
  if (typeof field !== 'string' || Object.keys(rest).length) return null
  if (typeof op !== 'string' || op === 'in' || !(FILTER_OPS as readonly string[]).includes(op)) return null
  if (value === undefined || value === null) return { field, op: op as GridClause['op'], value: '' }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null
  const typed = String(value)
  return parseValue(typed) === value ? { field, op: op as GridClause['op'], value: typed } : null
}

/** One test as a condition, or a test turned round (`not`) as the condition turned round. `eq` turned round is `neq`. */
function conditionOf(test: unknown): GridClause | null {
  if (!test || typeof test !== 'object' || Array.isArray(test) || !('not' in test) || Object.keys(test).length !== 1) return relationOf(test, false) ?? clauseOf(test)
  const turnedRelation = relationOf((test as { not: unknown }).not, true)
  if (turnedRelation) return turnedRelation
  const inner = clauseOf((test as { not: unknown }).not)
  if (!inner || inner.op === 'neq') return null
  return inner.op === 'eq' ? { ...inner, op: 'neq' } : { ...inner, not: true }
}

/** A relation leaf that reads what it reaches, as the condition it came from: `none` is the leaf turned round, and `all` turned round stays `all`, turned. */
function relationClauseOf(test: Extract<Filter, { relation: string }>, not: boolean): GridClause | null {
  const where = clausesOf(test.where)
  if (where === null) return null
  const match: RelationMatch = test.every ? 'all' : not ? 'none' : 'any'
  return { field: `r:${test.relation}`, op: 'exists', value: '', match, where, ...(test.every && not ? { not: true } : {}) }
}

/** A relation leaf as a condition: set at all, set to a target, or reading what it reaches. Null for anything else. */
function relationOf(test: unknown, not: boolean): GridClause | null {
  if (!test || typeof test !== 'object' || Array.isArray(test) || !('relation' in test)) return null
  const leaf = test as Extract<Filter, { relation: string }>
  if (typeof leaf.relation !== 'string') return null
  if (leaf.where !== undefined) return leaf.target === undefined ? relationClauseOf(leaf, not) : null
  if (leaf.every) return null
  const field = `r:${leaf.relation}`
  if (leaf.target === undefined) return { field, op: 'exists', value: '', ...(not ? { not: true } : {}) }
  return { field, op: not ? 'neq' : 'eq', value: leaf.target }
}

/**
 * The conditions a filter holds: none for no filter, one for a test, and one
 * each for tests joined with `and`. Null when the filter is anything else,
 * which is then left as it was written.
 */
export function clausesOf(filter: unknown): GridClause[] | null {
  if (filter === undefined || filter === null) return []
  const tests = typeof filter === 'object' && !Array.isArray(filter) && Array.isArray((filter as { and?: unknown }).and) && Object.keys(filter).length === 1 ? (filter as { and: unknown[] }).and : [filter]
  const clauses = tests.map(conditionOf)
  return clauses.every((c): c is GridClause => c !== null) ? clauses : null
}

/** A test, turned round when its condition says so. */
function turned(c: Pick<GridClause, 'not'>, test: Filter): Filter {
  return c.not ? { not: test } : test
}

/** The value a condition compares with: what was typed, read as a number or a boolean when it looks like one and its field does not hold text. */
export function clauseValue(c: Pick<GridClause, 'field' | 'op' | 'value'>, typeOf?: TypeOf): unknown {
  const type = typeOf?.(c.field)
  const one = (v: string) => (type && TEXT.has(type) ? v : parseValue(v))
  // A list to be among is its items as written, or the one value when it is not written as a list.
  if (c.op === 'in') return listOf(c.value) ?? [one(c.value)]
  return one(c.value)
}

/** A condition's value written as a list (a JSON array of plain values, as the text form writes one), or null when it is not one. */
export function listOf(v: string): (string | number | boolean | null)[] | null {
  try {
    const parsed: unknown = JSON.parse(v)
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== v) return null
    return parsed.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)) ? (parsed as (string | number | boolean | null)[]) : null
  } catch {
    return null
  }
}

/** The filter the conditions stand for: every one must hold. Nothing for none. */
export function filterOf(clauses: readonly GridClause[], typeOf?: TypeOf): Filter | undefined {
  const tests: Filter[] = clauses.map((c) => turned(c, c.op === 'exists' ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: clauseValue(c, typeOf) }))
  return tests.length === 0 ? undefined : tests.length === 1 ? tests[0] : { and: tests }
}

/** A filter with every test of one field made a test of another, at any depth. The filter itself when it tests no such field. */
export function fieldRenamed<T>(filter: T, from: string, to: string): T {
  let moved = false
  const walk = (f: unknown): unknown => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return f
    const node = f as Record<string, unknown>
    if (Array.isArray(node.and)) return { ...node, and: node.and.map(walk) }
    if (Array.isArray(node.or)) return { ...node, or: node.or.map(walk) }
    if (node.not !== undefined) return { ...node, not: walk(node.not) }
    if (node.field !== from) return f
    moved = true
    return { ...node, field: to }
  }
  const next = walk(filter)
  return moved ? (next as T) : filter
}

/**
 * The filter one condition stands for. A relation's eq and neq name the
 * target by id, key, or title; exists asks whether it is set; with `where`,
 * how many of what it reaches meet those conditions (`match`), each read on
 * the blueprint it reaches.
 */
export function clauseFilter(c: GridClause, typeOf?: TypeOf): Filter {
  const relation = clauseRelation(c)
  if (relation !== null && c.where) {
    const inner = typeOf?.through?.(relation)
    const where = allOf(c.where.filter((x) => x.field).map((x) => clauseFilter(x, inner))) ?? { and: [] }
    const match = c.match ?? 'any'
    const leaf: Filter = match === 'all' ? { relation, where, every: true } : { relation, where }
    return (match === 'none') !== !!c.not ? { not: leaf } : leaf
  }
  if (relation === null) return turned(c, c.op === 'exists' ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: clauseValue(c, typeOf) })
  if (c.op === 'exists' || !c.value) return turned(c, { relation })
  const match: Filter = { relation, target: c.value }
  return c.op === 'neq' ? { not: match } : match
}

/** Every part must hold: nothing for none, one part as itself. */
export function allOf(parts: readonly Filter[]): Filter | undefined {
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: [...parts] }
}

/** What a set of conditions and a search stand for: the conditions with a field named, and the search when there is one. */
export function conditionsFilter(clauses: readonly GridClause[], search?: string, typeOf?: TypeOf): Filter | undefined {
  return allOf([...clauses.filter((c) => c.field).map((c) => clauseFilter(c, typeOf)), ...(search?.trim() ? [{ search: search.trim() }] : [])])
}

/** The same test the other way round: `eq` and `neq` trade places, and any other test is turned round. */
export function opposite(c: GridClause): GridClause {
  // Any and none of what a relation reaches trade places; all is turned round.
  if (c.where) {
    const match = c.match ?? 'any'
    if (match !== 'all') return { field: c.field, op: c.op, value: c.value, where: c.where, match: match === 'any' ? 'none' : 'any', ...(c.not ? { not: true } : {}) }
    return { field: c.field, op: c.op, value: c.value, where: c.where, match, ...(c.not ? {} : { not: true }) }
  }
  if (c.op === 'eq' || c.op === 'neq') return { field: c.field, op: c.op === 'eq' ? 'neq' : 'eq', value: c.value }
  return c.not ? { field: c.field, op: c.op, value: c.value } : { field: c.field, op: c.op, value: c.value, not: true }
}

/** Whether two conditions ask the same. */
export function sameClause(a: GridClause, b: GridClause): boolean {
  return a.field === b.field && a.op === b.op && a.value === b.value && !a.not === !b.not && (a.match ?? 'any') === (b.match ?? 'any') && stable(a.where ?? null) === stable(b.where ?? null)
}

/**
 * The column a grid shares out, as the field a condition names: what the hub
 * keeps of every entity under a `$`, a field by its name, and a relation as
 * its column. Null for a column no condition reads.
 */
export function columnField(column: string): string | null {
  if (column === 'state' || column === 'owner' || column === 'status') return `$${column}`
  if (column.startsWith('f:')) return column.slice(2)
  if (column.startsWith('r:')) return column
  return null
}

/**
 * The condition that keeps the rows holding one value of a column a grid
 * shares out, or, `not`, the rows that do not. A list holds a value among
 * others, so it is asked whether it contains it; the rows with no value are
 * asked whether the column is set.
 */
export function shareClause(column: string, type: FieldType | undefined, value: string | null, not: boolean): GridClause | null {
  const field = columnField(column)
  if (field === null) return null
  const clause: GridClause = value === null ? { field, op: 'exists', value: '', not: true } : { field, op: type === 'array' ? 'contains' : 'eq', value }
  return not ? opposite(clause) : clause
}

/**
 * The conditions after one more is picked from a share of a column. Picking
 * the same again takes it away. It replaces what it contradicts: its own
 * opposite and, where a field holds one value, another value it must equal.
 */
export function withShare(clauses: readonly GridClause[], picked: GridClause): GridClause[] {
  if (clauses.some((c) => sameClause(c, picked))) return clauses.filter((c) => !sameClause(c, picked))
  const against = opposite(picked)
  const single = picked.op === 'eq' && clauseRelation(picked) === null
  return [...clauses.filter((c) => !sameClause(c, against) && !(single && c.field === picked.field && c.op === 'eq')), picked]
}
