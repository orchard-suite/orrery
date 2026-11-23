import type { RelationEnd } from '../shared/model.ts'
import { words } from './format.ts'

/** The things of one blueprint that point here through one relation: how many there are, and the first of them the page was sent. */
export interface IncomingKind {
  blueprint: string
  relation: string
  count: number
  ends: RelationEnd[]
}

/** One row of what points here: every relation that says the same thing, whichever blueprint declares it. */
export interface IncomingRow {
  id: string
  title: string
  count: number
  /** The most first, so the kind that matters most here leads. */
  kinds: IncomingKind[]
}

/** How a relation reads from the end it points at: its reverse title, without the hub's "(incoming)" fallback. */
export function incomingTitle(end: Pick<RelationEnd, 'title'>): string {
  return words(end.title.replace(/ \(incoming\)$/, ''))
}

/**
 * What points here, one row per thing it says. Many blueprints share a
 * relation such as `owner`, each with the same reverse title, so a person
 * owns services, domains, and machines in one "Owns" row, split by kind,
 * rather than in a row of its own for each blueprint. `counts`, by
 * `blueprint.relation`, says how many point here where the page was sent only
 * the first few.
 */
export function incomingRows(ends: readonly RelationEnd[], counts: Readonly<Record<string, number>> = {}): IncomingRow[] {
  const rows: IncomingRow[] = []
  for (const [key, same] of Map.groupBy(ends, (end) => incomingTitle(end).toLowerCase())) {
    const kinds = [...Map.groupBy(same, (end) => `${end.declaredOn}.${end.relation}`)]
      .map(([k, list]) => ({ blueprint: list[0]!.declaredOn, relation: list[0]!.relation, count: Math.max(counts[k] ?? 0, list.length), ends: list }))
      .sort((a, b) => b.count - a.count || a.blueprint.localeCompare(b.blueprint))
    rows.push({ id: `rel-in-${key.replace(/[^a-z0-9]+/g, '-')}`, title: incomingTitle(same[0]!), count: kinds.reduce((n, k) => n + k.count, 0), kinds })
  }
  return rows
}
