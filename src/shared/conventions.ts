// The estate's relation conventions: relations every blueprint of some
// groups names the same way, such as the pair that says who owns a thing at
// the platform layer. A convention only checks: the hub raises a finding for
// a blueprint that falls short and never adds a relation itself, so moving a
// blueprint to another group changes what is checked and never what it holds.

import { RESERVED_PREFIX, type Blueprint } from './model.ts'

export interface RelationConvention {
  /** A short name, unique among the conventions. */
  id: string
  title?: string
  description?: string
  /** The groups whose blueprints it holds to its relations. */
  groups: string[]
  /** The relations each of those blueprints names. */
  relations: string[]
}

export interface Conventions {
  conventions: RelationConvention[]
  /** The git source that declares them under `config.conventions`, while it does. */
  source?: string
}

export const NO_CONVENTIONS: Conventions = { conventions: [] }

/** One blueprint a convention holds that lacks some of its relations. */
export interface Unmet {
  convention: RelationConvention
  blueprint: string
  missing: string[]
}

/**
 * The blueprints that lack a relation a convention asks of their group, in
 * the conventions' order and then the blueprints'. The hub's own blueprints
 * are its to define, so no convention holds them.
 */
export function unmetConventions(conventions: RelationConvention[], blueprints: Pick<Blueprint, 'id' | 'group' | 'relations'>[]): Unmet[] {
  const out: Unmet[] = []
  for (const convention of conventions) {
    const groups = new Set(convention.groups)
    for (const bp of blueprints) {
      if (bp.id.startsWith(RESERVED_PREFIX) || !bp.group || !groups.has(bp.group)) continue
      const missing = convention.relations.filter((name) => !bp.relations[name])
      if (missing.length) out.push({ convention, blueprint: bp.id, missing })
    }
  }
  return out
}
