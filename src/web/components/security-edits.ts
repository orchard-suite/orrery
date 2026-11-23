// What the Who edits tab works out: the totals, what a rule being written
// would open, and the words for who changes a value. Pure, and tested alone.

import { isDerived, RESERVED_PREFIX, type Blueprint } from '../../shared/model.ts'
import { globRegExp, type AccessPolicy, type EditRule } from '../../shared/policy.ts'
import type { EditAuthority, EditBlueprint, EditReached } from '../../shared/posture.ts'

/** Who changes a value by hand, as a column heads it and as a chip says it. */
export const AUTHORITY: Record<EditAuthority, { label: string; chip: string; note: string }> = {
  rule: { label: 'By a rule', chip: 'Rule', note: 'Whoever an edit rule lets in: an audience, or the owners of the entity' },
  holders: { label: 'Edit holders', chip: 'Holders', note: 'Anyone who holds the "Edit entities" permission, over what a source says too' },
  admin: { label: 'Admins', chip: 'Admin', note: 'An admin alone, or a holder of access.values for what access is decided from' },
  source: { label: 'Sources only', chip: 'Source', note: 'Locked: only the sources that write it' },
  derived: { label: 'Worked out', chip: 'Derived', note: 'Nobody: the hub works it out from other values' },
}

/** Every blueprint's counts added up. */
export function totals(blueprints: readonly EditBlueprint[]): Record<EditAuthority, number> {
  const out: Record<EditAuthority, number> = { rule: 0, holders: 0, admin: 0, source: 0, derived: 0 }
  for (const bp of blueprints) for (const a of Object.keys(out) as EditAuthority[]) out[a] += bp.counts[a]
  return out
}

/** The blueprints whose title, id, or a name of theirs holds the text; with `only`, those with a value of that authority. */
export function narrowed(blueprints: readonly EditBlueprint[], text: string, only: EditAuthority | null): EditBlueprint[] {
  const needle = text.trim().toLowerCase()
  return blueprints.filter((bp) => (!only || bp.counts[only] > 0) && (!needle || `${bp.title} ${bp.id}`.toLowerCase().includes(needle) || bp.names.some((n) => `${n.name} ${n.title}`.toLowerCase().includes(needle))))
}

const matches = (patterns: readonly string[], name: string) => patterns.some((p) => globRegExp(p).test(name))

/** One blueprint a rule being written names: what it would open there, and what it names that no rule ever opens, with why. */
export interface RuleOpens {
  blueprint: string
  title: string
  fields: string[]
  relations: string[]
  never: { name: string; why: string }[]
}

/**
 * What a rule would open, read from the model as the page holds it: every
 * field and relation it names on every blueprint it names, less what no
 * rule opens. Once saved, the relations it lets owners in through are
 * guarded too; the hub says so after the save.
 */
export function ruleOpens(rule: Pick<EditRule, 'blueprints' | 'fields' | 'relations'>, blueprints: readonly Blueprint[]): RuleOpens[] {
  const out: RuleOpens[] = []
  for (const bp of blueprints) {
    if (bp.id.startsWith(RESERVED_PREFIX) || !matches(rule.blueprints, bp.id)) continue
    const decided = new Set(bp.decides?.names ?? [])
    const row: RuleOpens = { blueprint: bp.id, title: bp.title, fields: [], relations: [], never: [] }
    const fields: [string, Blueprint['fields'][string] | undefined][] = [...Object.entries(bp.fields), ...['title', 'icon'].filter((n) => !bp.fields[n]).map((n): [string, undefined] => [n, undefined])]
    for (const [name, def] of fields) {
      if (!matches(rule.fields, name)) continue
      const why = def && isDerived(def) ? 'the hub works it out' : def?.overridable === false ? 'locked to its sources' : def?.adminEdit ? 'an admin marked it' : decided.has(name) ? 'access is decided from it' : null
      if (why) row.never.push({ name, why })
      else row.fields.push(name)
    }
    for (const name of Object.keys(bp.relations)) {
      if (!matches(rule.relations, name)) continue
      if (decided.has(name)) row.never.push({ name, why: 'access is decided from it' })
      else row.relations.push(name)
    }
    out.push(row)
  }
  return out
}

/** Who a rule lets in, as a sentence part: "the Desk audience and the owners of the entity (as owner, team)". */
export function ruleWho(rule: EditRule, policy: AccessPolicy): string {
  const audiences = rule.audiences.map((id) => policy.audiences.find((a) => a.id === id)?.title ?? id)
  const parts: string[] = []
  if (audiences.length) parts.push(`the ${audiences.join(', ')} ${audiences.length === 1 ? 'audience' : 'audiences'}, on every entity`)
  if (rule.owned) {
    const roles = rule.owned.roles.length ? ` as ${rule.owned.roles.join(', ')}` : ''
    const through = rule.owned.through.length ? `, or of what it points at through ${rule.owned.through.join(', ')}` : ''
    parts.push(`the owners of the entity${roles}${through}`)
  }
  return parts.join(' and ') || 'nobody'
}

/** How one rule reaches one person on one blueprint, in words. */
export function reachWords(r: EditReached): string {
  if (r.how === 'audience') return 'on every one'
  const own = r.entities ? `on ${r.entities} of their own` : ''
  const through = r.through.length ? `on what points at theirs through ${r.through.join(', ')}` : ''
  return [own, through].filter(Boolean).join(', and ')
}
