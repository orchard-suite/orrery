// What a run changes in a list an entity holds. An input of a kind that does
// not pick, taking `many`, may name with `current` the list the entity holds
// now, such as the web origins an app allows. The form starts from it and
// shows the change against it, the hub keeps the list as it rendered it when
// the run was asked for, and the run page, the approvals record, and an agent
// read the change from these alone, so everyone is shown the same change.

import { kindOf, listOf } from './input-kinds.ts'
import type { ActionInputDef } from './model.ts'

/** True when an input edits a list the entity holds: a list of a kind that does not pick, with a `current`. */
export function editsList(def: Pick<ActionInputDef, 'type' | 'many' | 'current'> | undefined): boolean {
  return !!def && !!def.many && def.current !== undefined && !kindOf(def.type).picks
}

/** Any day: a value's shape never reads it, and a `current` is never held to the input's rules. */
const ANY_DAY = '2001-01-01'

/**
 * The list a rendered `current` names, each value as its kind stores it: a
 * list as it is, text one value a line, one value as a list of one, and
 * nothing as none. A value the kind does not take is kept as it was, so a
 * list that holds one still shows it, and it is never taken for another.
 */
export function heldList(def: Pick<ActionInputDef, 'type'>, rendered: unknown): unknown[] {
  if (rendered === null || rendered === undefined) return []
  const items = Array.isArray(rendered) ? rendered : typeof rendered === 'string' ? (listOf(rendered) ?? []) : [rendered]
  const kind = kindOf(def.type)
  return items
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => {
      const shaped = kind.check({}, v, { today: ANY_DAY })
      return shaped.ok ? shaped.value : v
    })
}

/** What a list becomes against the one held: what it adds and removes, and what it keeps, each in the order it is listed and each once. */
export interface ListChange {
  added: unknown[]
  removed: unknown[]
  unchanged: unknown[]
}

const keyOf = (v: unknown): string => JSON.stringify(v)

/** Each value of a list once, in its order. */
function once(list: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  return list.filter((v) => {
    const k = keyOf(v)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** A list against the one held, as sets: neither its order nor a value given twice changes anything. */
export function listChange(held: readonly unknown[], next: readonly unknown[]): ListChange {
  const had = new Set(held.map(keyOf))
  const has = new Set(next.map(keyOf))
  return {
    added: once(next).filter((v) => !had.has(keyOf(v))),
    removed: once(held).filter((v) => !has.has(keyOf(v))),
    unchanged: once(next).filter((v) => had.has(keyOf(v))),
  }
}

/** True when a change adds or removes something. */
export function changes(c: ListChange): boolean {
  return c.added.length > 0 || c.removed.length > 0
}

/**
 * The change each input that edits a list makes, by name: its value against
 * the list kept for it. An input that has no kept list, or holds no list, is
 * left out.
 */
export function runChanges(defs: Record<string, ActionInputDef> | undefined, inputs: Record<string, unknown>, kept: Record<string, unknown[]> | null | undefined): Record<string, ListChange> {
  const out: Record<string, ListChange> = {}
  for (const [name, held] of Object.entries(kept ?? {})) {
    const def = defs?.[name]
    const value = inputs[name]
    if (!editsList(def) || !Array.isArray(held)) continue
    out[name] = listChange(held, Array.isArray(value) ? value : [])
  }
  return out
}

/** A change in words, for a record or an agent: one line for what it adds and one for what it removes, or one that says it changes nothing. */
export function changeLines(title: string, c: ListChange, text: (v: unknown) => string = String): string[] {
  if (!changes(c)) return [`${title}: changes nothing`]
  return [...(c.added.length ? [`${title} adds: ${c.added.map(text).join(', ')}`] : []), ...(c.removed.length ? [`${title} removes: ${c.removed.map(text).join(', ')}`] : [])]
}
