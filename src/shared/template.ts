// The templating an action uses: `{{ path }}` over a fixed scope. Small on
// purpose, like the filter: a dotted path and nothing else, so the web app
// can render a form the same way the hub renders a payload.

import { entityId, type Blueprint, type Entity } from './model.ts'

export type Scope = Record<string, unknown>

const WHOLE = /^\s*\{\{\s*([\w$][\w$.-]*)\s*\}\}\s*$/
const EACH = /\{\{\s*([\w$][\w$.-]*)\s*\}\}/g

/**
 * The value at a dotted path into the scope, or undefined. A number after a
 * list picks one item; a name after a list reads it on every item, leaving
 * out those that have none, so `inputs.workloads.key` is the list of keys.
 */
export function lookup(scope: Scope, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (Array.isArray(cur) && !/^\d+$/.test(part)) cur = cur.map((item) => step(item, part)).filter((v) => v !== null && v !== undefined)
    else cur = step(cur, part)
    if (cur === undefined) return undefined
  }
  return cur
}

function step(cur: unknown, part: string): unknown {
  if (Array.isArray(cur)) return /^\d+$/.test(part) ? cur[Number(part)] : undefined
  if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[part]
  return undefined
}

/**
 * Renders every string in a value. A string that is exactly one `{{ path }}`
 * becomes the value at the path, whatever its type, so a template can give
 * a list or a number; a path that reaches nothing becomes null. Any other
 * string has each `{{ path }}` written into it, objects as JSON, nothing as
 * an empty string. Objects and arrays are rendered through.
 */
export function render(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value)
    if (whole) return lookup(scope, whole[1]!) ?? null
    return value.replace(EACH, (_, path: string) => text(lookup(scope, path)))
  }
  if (Array.isArray(value)) return value.map((v) => render(v, scope))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope)]))
  return value
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** True when a value holds a template anywhere inside it. */
export function hasTemplate(value: unknown): boolean {
  if (typeof value === 'string') return EACH.test(value) && ((EACH.lastIndex = 0), true)
  if (Array.isArray(value)) return value.some(hasTemplate)
  if (value && typeof value === 'object') return Object.values(value).some(hasTemplate)
  return false
}

/** Every path a value's templates name, for knowing which inputs an input depends on. */
export function pathsOf(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(EACH)].map((m) => m[1]!)
  if (Array.isArray(value)) return value.flatMap(pathsOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(pathsOf)
  return []
}

/**
 * An entity as a template sees it: its fields, and its relations as entity
 * ids. A relation declared `many: false` is one id, or null; any other is a
 * list. The same shape on both sides, so `{{ entity.relations.namespace }}`
 * means one thing.
 */
export function scopeEntity(e: Entity, bp: Pick<Blueprint, 'relations'> | undefined): Scope {
  const relations: Record<string, unknown> = {}
  for (const [name, refs] of Object.entries(e.relations)) {
    const def = bp?.relations[name]
    const ids = refs.map(entityId)
    relations[name] = def && !def.many ? (ids[0] ?? null) : ids
  }
  for (const name of Object.keys(bp?.relations ?? {})) relations[name] ??= bp!.relations[name]!.many ? [] : null
  return { id: e.id, blueprint: e.blueprint, key: e.key, title: e.title, icon: e.icon, state: e.state, status: e.status.level, fields: e.fields, relations }
}
