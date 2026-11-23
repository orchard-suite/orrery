// What an edit rule opens to the reader on one entity, as the hub said of it
// (`editable`). Whoever holds `entities.edit` is told by `useCanEdit`; this is
// the other way in, judged entity by entity.

import type { EntityPatch } from '../shared/api.ts'
import type { Entity } from '../shared/model.ts'

type Marked = Pick<Entity, 'editable'>

/** Whether an edit rule opens one field or relation of this entity to the reader: `title` and `icon` are fields. */
export function opened(e: Marked, kind: 'field' | 'relation', name: string): boolean {
  return !!(kind === 'field' ? e.editable?.fields : e.editable?.relations)?.includes(name)
}

/** Whether a rule opens anything on this entity to the reader. */
export function anyOpened(e: Marked): boolean {
  return !!e.editable && e.editable.fields.length + e.editable.relations.length > 0
}

/** The grid columns, by id (`f:<field>`, `r:<relation>`), a rule opens to the reader on at least one of these rows. */
export function openedColumns(rows: readonly Marked[]): Set<string> {
  const out = new Set<string>()
  for (const e of rows) {
    for (const name of e.editable?.fields ?? []) out.add(`f:${name}`)
    for (const name of e.editable?.relations ?? []) out.add(`r:${name}`)
  }
  return out
}

/** What an empty value that is the reader's to fill says: "Add a description", "Add an owner", "Add notes". */
export function addWords(title: string): string {
  const name = title.trim().toLowerCase()
  if (!name) return 'Add a value'
  if (name.endsWith('s')) return `Add ${name}`
  return `Add ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`
}

/** How many of a person's own things hold no value of a field: "31 have no description", "1 has no runbook". */
export function fillWords(count: number, title: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'has' : 'have'} no ${title.trim().toLowerCase()}`
}

/**
 * The patch that puts a hand edit back: each field to the hand value it
 * held before, null where it held none, and each relation to what it named
 * by hand. Null for a change that kept nothing to put back.
 */
export function putBack(detail: Record<string, unknown>): EntityPatch | null {
  const was = detail.was && typeof detail.was === 'object' ? (detail.was as Record<string, unknown>) : {}
  const rel = detail.wasRelations && typeof detail.wasRelations === 'object' ? (detail.wasRelations as Record<string, string[]>) : {}
  const fields = Object.keys(was)
  const relations = Object.keys(rel)
  if (!fields.length && !relations.length) return null
  return {
    ...(fields.length ? { fields: was } : {}),
    ...(relations.length ? { relations: Object.fromEntries(relations.map((name) => [name, rel[name]!.length ? rel[name]! : null])) } : {}),
  }
}

/** Whether every value a patch names is the reader's to change on this entity by an edit rule. */
export function allOpened(e: Marked, patch: EntityPatch): boolean {
  return Object.keys(patch.fields ?? {}).every((n) => opened(e, 'field', n)) && Object.keys(patch.relations ?? {}).every((n) => opened(e, 'relation', n))
}
