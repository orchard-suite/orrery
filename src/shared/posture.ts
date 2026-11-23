// The security posture: the wire types of the admin page that audits who
// sees, changes, and runs what, and changes it in bulk. Both the server and
// the web app import this file.

import type { AccessGrant, ActionRule, EntityRef, Filter, PersonSetting } from './model.ts'
import type { PolicyState } from './policy.ts'

/** Something an access rule sits on: a blueprint, one of its fields, or an action. */
export type PostureTarget = { kind: 'blueprint'; id: string } | { kind: 'field'; blueprint: string; field: string } | { kind: 'action'; id: string }

/** A target's stable id, for lists and selections. */
export function targetId(t: PostureTarget): string {
  return t.kind === 'field' ? `field:${t.blueprint}.${t.field}` : `${t.kind}:${t.id}`
}

/** Why only an admin changes a blueprint's entities, when only an admin does. */
export type AdminOnlyReason = 'marked' | 'person' | 'decides access'

/** Who may see, change, or run one target, as the model says today. */
export interface PostureItem {
  target: PostureTarget
  title: string
  /** The blueprint's menu section; for a field its blueprint's, for an action its group. */
  group: string | null
  /** Who defines it: git, a source, the web app, an import, the hub. A git one is changed in its catalog file. */
  origin: string
  /** Open to every signed-in person: no rule on a blueprint or field, `everyone` on an action. An action with neither is an admin's alone. */
  open: boolean
  grants: AccessGrant[]
  /** The audiences its rule names. For a field in a class, the class's. */
  audiences: string[]
  /** For a field: the class that decides who sees it, by id. */
  class: string | null
  /** For a field in a class that also carries a rule of its own: the class sets that rule aside. */
  setAside: boolean
  /** For a field: whether who sees it has been decided, or only left open. */
  coverage: FieldCoverage | null
  /** Marked so only an admin changes it. */
  adminEdit: boolean
  /** For a blueprint: why only an admin changes its entities, when only an admin does. */
  adminOnly: AdminOnlyReason | null
  /** Why it is worth a look, in words. */
  sensitive: string[]
  /** How many of the known people may see it (blueprint, field) or run it (action). */
  people: number
  /**
   * For a field: `summary` when it is an aggregation marked so, and
   * `summaryOnly` how many of `people` see it by that mark alone: they may
   * not see what it reads, and get its number and nothing else.
   */
  field?: { type: string; summary?: boolean; summaryOnly?: number }
  action?: {
    blueprints: string[]
    backend: string
    approval: boolean
    where: Filter | null
    rules: ActionRule[]
    /** The icon it is drawn with, as the reader of the page sees it. */
    icon?: string
    /** The entity it belongs to, as the reader of the page sees it. Null when it names none, the catalog holds none, or the reader may not see it. */
    home?: { id: string; title: string } | null
    /** Its home's people may run it. */
    homePeople?: boolean
    /** Everyone signed in may run it. */
    everyone?: boolean
    /** When it was last asked for, by anyone. Null when it never was. */
    lastRunAt?: string | null
    /** How many times it was asked for in the last 90 days. */
    runs90?: number
  }
}

export type PostureSeverity = 'high' | 'medium' | 'low'

/**
 * How a field's reach was decided. `classified`: a class decides. `ruled`: a
 * rule of its own decides. `reviewed`: open, and an admin reviewed its
 * blueprint with it there. `unreviewed`: open because nobody decided.
 */
export type FieldCoverage = 'classified' | 'ruled' | 'reviewed' | 'unreviewed'

/** A named audience, with whom it lets in today and what names it. */
export interface PostureAudience {
  id: string
  title: string
  description?: string
  /** The known people and tokens it lets in, nested audiences included. */
  members: string[]
  /** Addresses it names that no person or token the hub knows answers to. */
  strangers: string[]
  /** Every blueprint, field, and action whose own rule names it, directly or through an audience that holds it. */
  targets: PostureTarget[]
  /** Classes that name it. */
  classes: string[]
  /** Audiences that hold this one. */
  heldBy: string[]
}

/** A field class, with every field it covers today. */
export interface PostureClass {
  id: string
  title: string
  description?: string
  audiences: string[]
  fields: { blueprint: string; field: string }[]
  /** The fields that carry a rule of their own the class sets aside. */
  setAside: { blueprint: string; field: string }[]
}

/**
 * One column of the access map: an audience, or everyone in none, with how
 * many of its people who are not admins see each blueprint and how many of
 * its fields they cannot see.
 */
export interface PostureMapColumn {
  /** The audience's id, or null for the people in no audience. */
  audience: string | null
  title: string
  people: number
  cells: Record<string, { sees: number; hidden: number }>
}

/** One blueprint in the review queue: when it came, when it was last reviewed, and the fields that came since. */
export interface PostureReviewRow {
  blueprint: string
  title: string
  group: string | null
  createdAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  fields: number
  /** Fields it holds that the last review did not see; every field when it was never reviewed. */
  newFields: string[]
  /** Whether everyone signed in sees the blueprint. */
  open: boolean
}

/** Something in the access rules worth a person's look, with what it is about. */
export interface PostureFinding {
  id: string
  /** What kind of finding it is, in words for many of them, so findings of one kind are read as one. */
  family: string
  severity: PostureSeverity
  title: string
  detail: string
  targets: PostureTarget[]
  /** The people or tokens it is about, by name. */
  who: string[]
}

/** A person the hub knows, or a machine access token. */
export interface PosturePrincipal {
  kind: 'person' | 'token'
  name: string
  admin: boolean
  roles: string[]
  permissions: string[]
  /** For a person: whether they have signed in. A person entity nobody has signed in as is judged too. */
  signedIn: boolean
}

/**
 * One value a grant lets in, such as team helpdesk: the people it lets in,
 * and every blueprint, field, and action whose rule names it. A team is
 * whatever the rules grant to; nothing else in the model calls it one.
 */
export interface PostureTeam {
  /** `path|field|value`, stable for lists. */
  id: string
  /** The grant in words, such as "team is helpdesk". */
  words: string
  grant: AccessGrant
  /** The known people it lets in today, admins included. */
  members: string[]
  /** Every target whose rule holds this value, in the posture's order. */
  targets: PostureTarget[]
}

export interface PostureResponse {
  person: PersonSetting | null
  principals: PosturePrincipal[]
  items: PostureItem[]
  findings: PostureFinding[]
  teams: PostureTeam[]
  policy: PolicyState
  audiences: PostureAudience[]
  classes: PostureClass[]
  /** Every blueprint, newest first: never reviewed, or holding fields the last review did not see, at the top. */
  review: PostureReviewRow[]
  /** Fields by how their reach was decided. */
  coverage: Record<FieldCoverage, number>
  map: PostureMapColumn[]
  /** Values set by hand on what access is decided from, newest first, for someone to keep or clear. */
  handmade: PostureHandmade[]
}

/**
 * One value a person set by hand on a field or relation access is decided
 * from. `over` when it stands over what a source sent; else it is the only
 * value. Clearing it gives the field or relation back to its sources.
 */
export interface PostureHandmade {
  entity: EntityRef
  title: string
  name: string
  kind: 'field' | 'relation'
  over: boolean
  by: string | null
  at: string | null
}

/** Who gains and loses sight of what, were a new policy saved. */
export interface PolicyPreview {
  problems: string[]
  items: { target: PostureTarget; title: string; gains: string[]; loses: string[] }[]
  saved: boolean
}

/** What one person or token may do. */
export interface PostureReach {
  principal: PosturePrincipal
  /** `opened`: what edit rules open to them there, on every entity or on the ones that are theirs, when they do not change the blueprint's entities anyway. */
  /** `summaries`: the fields they see by a summary mark alone, as a number and nothing of what it reads. */
  blueprints: { id: string; title: string; sees: boolean; changes: boolean; hidden: string[]; summaries?: string[]; locked: string[]; opened?: EditReached[] }[]
  actions: { id: string; title: string; runs: boolean; offered: boolean; via: string | null }[]
}

/** Everyone who may see, change, or run one target, and how. */
export interface PostureWho {
  target: PostureTarget
  title: string
  /** For a field: it is an aggregation marked `summary`, so its number is shown to people who may not see what it reads. */
  summary?: boolean
  /** `summaryOnly`: this one sees the field by its summary mark alone. */
  rows: { principal: PosturePrincipal; sees: boolean; changes: boolean; runs: boolean; via: string | null; summaryOnly?: boolean }[]
}

/** One change to many targets: their access, their admin-only mark, or both. */
export interface PostureChange {
  targets: PostureTarget[]
  access?: {
    /** `set` replaces the grants and `add` and `remove` change them; `clear` opens a blueprint or field to everyone and gives an action back to admins alone. */
    op: 'set' | 'add' | 'remove' | 'clear'
    grants?: AccessGrant[]
    /** Actions only: open to everyone signed in, or not. */
    everyone?: boolean
    /** Audiences, changed the way `op` changes the grants. */
    audiences?: string[]
  }
  /** Blueprints and fields only: only an admin changes it. */
  adminEdit?: boolean
}

export interface PosturePreviewItem {
  target: PostureTarget
  title: string
  /** Why this target is left as it is, when it is. */
  refused: string | null
  changed: boolean
  /** People and tokens who could see or run it after and could not before, and the reverse. */
  gains: string[]
  loses: string[]
  /** Who could change it before and after, where the admin-only mark moves. */
  gainsChange: string[]
  losesChange: string[]
}

export interface PosturePreview {
  items: PosturePreviewItem[]
  /** Blueprints that would become admin-only, or stop being, because a grant's path starts or stops reading them or a mark moves. */
  adminOnly: { added: string[]; removed: string[] }
  /** True once the change is saved. */
  saved: boolean
}

/** One edit rule as it reaches one person on one blueprint: on every entity (`audience`), or on the `entities` that are theirs (`owner`), and on what points at theirs through `through`. */
export interface EditReached {
  rule: string
  how: 'audience' | 'owner'
  entities: number
  through: string[]
  fields: string[]
  relations: string[]
}

/**
 * Who changes a value by hand, in one word. `derived`: nobody, the hub works
 * it out. `source`: only the sources that write it. `admin`: an admin, and
 * for what access is decided from a holder of `access.values`. `rule`:
 * whoever an edit rule lets in, and a holder of `entities.edit` where the
 * blueprint is not an admin's alone. `holders`: a holder of `entities.edit`.
 */
export const EDIT_AUTHORITIES = ['rule', 'holders', 'admin', 'source', 'derived'] as const
export type EditAuthority = (typeof EDIT_AUTHORITIES)[number]

/** One field or relation of a blueprint with who changes it by hand, and why. */
export interface EditName {
  name: string
  title: string
  kind: 'field' | 'relation'
  authority: EditAuthority
  why: string
  /** The edit rules that open it, by id. */
  rules: string[]
}

export interface EditBlueprint {
  id: string
  title: string
  group: string | null
  /** How many active entities it holds. */
  entities: number
  counts: Record<EditAuthority, number>
  names: EditName[]
}

/** A hand value standing over what a source says: it stays until the source says something else, or someone takes it off. */
export interface StandingOverride {
  blueprint: string
  key: string
  title: string
  field: string
  value: unknown
  /** What the source says under it. */
  pushed: unknown
  source: string
  by: string
  at: string
  /** True when the field is sticky: the hand value stays even when the source moves. */
  sticky: boolean
}

/** Who edits what by hand: every blueprint's values by authority, the standing overrides, and, for one person, what the rules open to them. */
export interface EditsResponse {
  blueprints: EditBlueprint[]
  overrides: StandingOverride[]
  /** How many overrides stand in all; `overrides` holds the oldest. */
  overridesTotal: number
  person?: { name: string; admin: boolean; holds: boolean; known: boolean; opened: ({ blueprint: string } & EditReached)[] }
}
