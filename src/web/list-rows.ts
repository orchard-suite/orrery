// What the list editor of an action's form works out: a `many` input of a
// kind that does not pick (text, a number, an address, a link) is asked a
// row a value. Pure, so the rows, a paste, and what is said of a row are
// tested alone.

import { kindOf, type InputShape } from '../shared/input-kinds.ts'
import { editsList, heldList } from '../shared/list-change.ts'
import type { ActionInputDef } from '../shared/model.ts'
import { render, type Scope } from '../shared/template.ts'

/**
 * Where an input that changes a list starts without a default: the list the
 * entity holds now, as its `current` renders over the scope. Nothing for any
 * other input, one with a default, or a list that holds nothing.
 */
export function startList(def: ActionInputDef, scope: Scope): unknown[] | undefined {
  if (def.default !== undefined || !editsList(def)) return undefined
  const held = heldList(def, render(def.current, scope))
  return held.length ? held : undefined
}

/** One row of the editor: its text, under an id that stays with it as rows come and go. */
export interface ListRow {
  id: number
  text: string
}

/** The texts a held value shows as, a row each: a list as its items, nothing as one empty row to type in. */
export function rowTexts(value: unknown): string[] {
  const items = Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined).map(String) : typeof value === 'string' && value !== '' ? value.split(/\r?\n/) : []
  return items.length ? items : ['']
}

/** What the rows hold, as the form sends it: each row trimmed, an empty one dropped, and nothing for no row at all. */
export function rowsValue(texts: readonly string[]): string[] | undefined {
  const kept = texts.map((t) => t.trim()).filter(Boolean)
  return kept.length ? kept : undefined
}

/**
 * The rows after a paste into one of them: what was pasted takes the place of
 * what was selected, and a paste of several lines becomes a row a line, each
 * trimmed, with a line that holds nothing dropped. Null for a paste of one
 * line, which the box takes as it is. `focus` is the row the cursor goes to:
 * the last one pasted.
 */
export function pasteRows(texts: readonly string[], index: number, pasted: string, start: number | null, end: number | null): { texts: string[]; focus: number } | null {
  if (!/\r?\n/.test(pasted.replace(/(\r?\n)+$/, ''))) return null
  const here = texts[index] ?? ''
  const from = start ?? here.length
  const to = end ?? from
  const lines = (here.slice(0, from) + pasted + here.slice(to))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const placed = lines.length ? lines : ['']
  return { texts: [...texts.slice(0, index), ...placed, ...texts.slice(index + 1)], focus: index + placed.length - 1 }
}

/**
 * What is wrong with one row, or null: what its kind and the input's rules
 * say of it, or that an earlier row holds the same value, as the kind stores
 * it. An empty row says nothing: it is dropped when the form is sent.
 */
export function rowProblem(def: InputShape, texts: readonly string[], index: number, today: string): string | null {
  const text = (texts[index] ?? '').trim()
  if (!text) return null
  const kind = kindOf(def.type)
  const checked = kind.check(def, text, { today })
  if (!checked.ok) return sentence(checked.error)
  const key = JSON.stringify(checked.value)
  const earlier = texts.slice(0, index).findIndex((t) => {
    const other = t.trim() && kind.check(def, t.trim(), { today })
    return !!other && other.ok && JSON.stringify(other.value) === key
  })
  return earlier >= 0 ? `Already in the list, in row ${earlier + 1}` : null
}

const sentence = (text: string): string => (/^[a-z]/.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text)
