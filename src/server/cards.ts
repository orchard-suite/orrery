// What an agent is shown of the catalog: small answers that say how to read
// more. Nothing here returns "all": a list is a page, a thing is a card, a
// value too big to show is said, and every cut names the call that reads the
// rest. The MCP tools shape every answer through it.

import { entityId, type Entity, type EntityRef, type Filter, type RelationEnd } from '../shared/model.ts'

/** How many links of one relation a card shows; the count says how many there are. */
export const CARD_LINKS = 5
/** How many links of one relation one thing's page shows. */
export const SHOWN_LINKS = 10
/** A value longer than this, as text, is said rather than shown on a card. */
export const CARD_VALUE_CHARS = 200
/** How much of a card's values, as text, a card shows when no fields were asked for: the rest are named. */
export const CARD_FIELDS_CHARS = 600
/** A value longer than this, as text, is cut on one thing's page. */
export const SHOWN_VALUE_CHARS = 4000
/** How many things a page holds when the caller does not say. */
export const PAGE = 20
/** The most things one page may hold. */
export const PAGE_MAX = 100
/** How many of the things a walk reached it shows; the counts by blueprint cover them all. */
export const WALK_NODES = 40

/** The next call that reads what an answer left out: a tool and the arguments to give it. */
export interface More {
  tool: string
  args: Record<string, unknown>
}

/** One relation's links as an answer shows them: how many there are, the first few, and how to read the rest when they were cut. */
export interface Links {
  count: number
  ids: string[]
  more?: More
}

/** A thing as a list shows it: what it is, how it is, its small values, and how many it links to. */
export interface Card {
  id: string
  title: string
  state: string
  status: string
  reasons?: string[]
  fields: Record<string, unknown>
  /** The fields that hold a value and did not fit on the card, by name: ask for them with fields, or read the thing with get_entity. */
  moreFields?: string[]
  relations: Record<string, Links>
}

/** A value too big for where it is shown, said instead: what it is, and how big. */
export interface Said {
  cut: string
}

/** The search that pages through the entities of `target` that `from` points at along its `relation`. */
export function outgoingMore(from: EntityRef, relation: string, target: string): More {
  return { tool: 'search_entities', args: { blueprint: target, filter: { relation: `<-${from.blueprint}:${relation}`, target: entityId(from) } } }
}

/** The search that pages through the entities of `declaredOn` whose `relation` points at `to`, newest first. */
export function incomingMore(declaredOn: string, relation: string, to: EntityRef): More {
  return { tool: 'search_entities', args: { blueprint: declaredOn, filter: { relation, target: entityId(to) }, sort: '-updatedAt' } }
}

/** The first sentence of a description: what a list of kinds says of each. */
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/)
  return end < 0 ? text : text.slice(0, end + 1)
}

/** A word of a person's, without its plural ending: "approvals" and "policies" find "approval" and "policy" as part of a longer text. */
export function stem(word: string): string {
  const w = word.toLowerCase()
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1)
  return w
}

/**
 * A person's words as a filter. Every word must hold of a thing, in any
 * order: found in its text, or naming its kind, since people say "approvals"
 * and "services" for the kind and no thing holds that word. `kinds` is every
 * blueprint the reader sees, with the words of its title.
 */
export function wordsFilter(q: string, kinds: readonly { id: string; title: string }[]): Filter[] {
  const named = kinds.map((k) => ({ id: k.id, stems: `${k.title} ${k.id.replaceAll('_', ' ')}`.split(/\s+/).filter(Boolean).map(stem) }))
  return q.split(/\s+/).filter(Boolean).map((word): Filter => {
    const s = stem(word)
    const of = named.filter((k) => k.stems.includes(s)).map((k) => k.id)
    return of.length ? { or: [{ search: s }, { field: '$blueprint', op: 'in', value: of }] } : { search: s }
  })
}

/** A value as it is shown when it may be at most `chars` long as text: itself, or what it is and how big. */
export function bounded(value: unknown, chars: number): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length <= chars ? value : `${value.slice(0, chars)}… (cut: ${value.length} characters)`
  const text = JSON.stringify(value)
  if (text.length <= chars) return value
  return { cut: Array.isArray(value) ? `a list of ${value.length}` : `an object of ${Object.keys(value as object).length} keys, ${text.length} characters` } satisfies Said
}

/**
 * A thing as a list shows it. With `fields`, those alone. Without, its values
 * in the order its blueprint declares them, each small enough to read at a
 * glance or said, until the card holds `CARD_FIELDS_CHARS` of them: the rest
 * are named, so a page of cards stays small however many fields a kind has.
 * Each relation it declares shows how many it links to and the first few,
 * with the search that reads them all when they were cut.
 */
export function card(e: Entity, fields?: readonly string[], targets: (relation: string) => string | undefined = () => undefined): Card {
  const shown: [string, unknown][] = []
  const named: string[] = []
  if (fields) for (const f of fields) if (f in e.fields) shown.push([f, bounded(e.fields[f], CARD_VALUE_CHARS)])
  if (!fields) {
    let room = CARD_FIELDS_CHARS
    for (const [k, v] of Object.entries(e.fields)) {
      if (v === null || v === undefined || v === '') continue
      const value = bounded(v, CARD_VALUE_CHARS)
      const size = k.length + JSON.stringify(value).length
      if (size > room) named.push(k)
      else (shown.push([k, value]), (room -= size))
    }
  }
  return {
    id: e.id,
    title: e.title,
    state: e.state,
    status: e.status.level,
    ...(e.status.reasons.length ? { reasons: e.status.reasons } : {}),
    fields: Object.fromEntries(shown),
    ...(named.length ? { moreFields: named } : {}),
    relations: Object.fromEntries(Object.entries(e.relations).filter(([, refs]) => refs.length).map(([name, refs]) => [name, links(e, name, refs.map(entityId), targets(name))])),
  }
}

/** One relation's links on a card, the first few of them, and the search for the rest when the relation's target blueprint is known. */
function links(from: EntityRef, relation: string, ids: string[], target: string | undefined): Links {
  if (ids.length <= CARD_LINKS) return { count: ids.length, ids }
  return { count: ids.length, ids: ids.slice(0, CARD_LINKS), ...(target ? { more: outgoingMore(from, relation, target) } : {}) }
}

/** A link as one thing's page shows it: whom, by title, and whether it is broken. */
export interface ShownLink {
  id: string
  title: string | null
  pending?: true
  dangling?: true
}

/** One way a thing is linked, on its page: the relation, from or to which blueprint, how many, the first few, and how to read the rest. */
export interface LinkGroup {
  relation: string
  /** The blueprint at the other end. */
  blueprint: string
  count: number
  links: ShownLink[]
  more?: More
}

/** What `from` points at, one group a relation, each cut to `SHOWN_LINKS`. */
export function outgoingGroups(from: EntityRef, ends: readonly RelationEnd[]): LinkGroup[] {
  return [...Map.groupBy(ends, (o) => o.relation)].map(([relation, group]) => {
    const blueprint = group[0]!.target.blueprint
    return {
      relation,
      blueprint,
      count: group.length,
      links: group.slice(0, SHOWN_LINKS).map(shown),
      ...(group.length > SHOWN_LINKS ? { more: outgoingMore(from, relation, blueprint) } : {}),
    }
  })
}

/**
 * What points at a thing, one group a relation of a blueprint. `ends` holds
 * the first links of each and `counts`, by `blueprint.relation`, how many
 * there are; a group with more than it shows names the search for the rest.
 */
export function incomingGroups(to: EntityRef, ends: readonly RelationEnd[], counts: Readonly<Record<string, number>>): LinkGroup[] {
  return [...Map.groupBy(ends, (o) => `${o.declaredOn}.${o.relation}`)].map(([k, group]) => {
    const count = counts[k] ?? group.length
    const { declaredOn, relation } = group[0]!
    return {
      relation,
      blueprint: declaredOn,
      count,
      links: group.slice(0, SHOWN_LINKS).map(shown),
      ...(count > Math.min(group.length, SHOWN_LINKS) ? { more: incomingMore(declaredOn, relation, to) } : {}),
    }
  })
}

function shown(o: RelationEnd): ShownLink {
  return { id: entityId(o.target), title: o.targetTitle, ...(o.pending ? { pending: true as const } : {}), ...(o.dangling ? { dangling: true as const } : {}) }
}
