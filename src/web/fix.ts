// A failing rule that one value would mend: which field that is, and what to
// say to a reader who may not change it. Pure, and tested alone.

import { isDerived, type Blueprint, type FieldProvenance, type Filter } from '../shared/model.ts'

/**
 * The one field of the entity itself a rule tests, when changing that field
 * is how the rule is met: a single test of a written field, turned round or
 * not. Null for a rule that reads a relation, a derived value, something of
 * the entity that is no field (`$status`), or more than one thing.
 */
export function fixField(where: Filter, bp: Pick<Blueprint, 'fields'> | undefined): string | null {
  const leaf = 'not' in where ? where.not : where
  if (!bp || !leaf || typeof leaf !== 'object' || !('field' in leaf) || typeof leaf.field !== 'string') return null
  const def = bp.fields[leaf.field]
  return def && !isDerived(def) ? leaf.field : null
}

/**
 * Why a reader may not mend a value here, and where it is mended. `held` is
 * what keeps a holder of the edit permission off it, empty for a reader who
 * holds none.
 */
export function whyNotYours(held: string, from: Pick<FieldProvenance, 'layer' | 'source' | 'file'> | undefined, value: unknown): string {
  if (held) return held
  if (from?.layer === 'git') return `Set in git${from.file ? ` (${from.file})` : ''}: change it there`
  const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  if ((from?.layer === 'pushed' || from?.layer === 'override') && !empty) return `Comes from ${from.source ?? 'a source'}: change it there`
  return 'Not yours to change: its owner or an admin can'
}
