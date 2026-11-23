// The model in words, for the phone, where a blueprint reads as sentences a
// person changes by tapping their parts. Each kind of field has a name in
// words and a line on what it is for, and a field worked out from others
// says how in words: "the count of every Service that points at it as
// Pillars". A path longer than one hop is said as the path itself.

import { clausesOf } from '../shared/clauses.ts'
import { parsePath, splitMirror, type Hop } from '../shared/filter.ts'
import type { AggregationDef, Blueprint, BlueprintNamer, FieldDef, FieldType } from '../shared/model.ts'
import { sentence } from './conditions.ts'
import { words as said } from './format.ts'

/** Each kind of field in words, with what it holds, in the order a person picks from. */
export const KINDS: { type: FieldType; words: string; meaning: string }[] = [
  { type: 'string', words: 'text', meaning: 'A name, a code, a short line.' },
  { type: 'number', words: 'a number', meaning: 'Sorts and adds up. Can show as money.' },
  { type: 'enum', words: 'one of a list', meaning: 'Values you name, such as tiers. Each can wear a colour.' },
  { type: 'boolean', words: 'yes or no', meaning: 'A tick, such as "has a runbook".' },
  { type: 'datetime', words: 'a date and time', meaning: 'When something happened or is due.' },
  { type: 'url', words: 'a link', meaning: 'An address, drawn as the site’s logo.' },
  { type: 'markdown', words: 'markdown', meaning: 'Notes with headings, lists, and links.' },
  { type: 'user', words: 'a person', meaning: 'Someone who signs in here.' },
  { type: 'email', words: 'an email address', meaning: 'Shown as a link that writes to it.' },
  { type: 'array', words: 'a list', meaning: 'Several values, such as topics.' },
  { type: 'object', words: 'an object', meaning: 'Named values together, such as labels.' },
  { type: 'trend', words: 'a trend', meaning: 'How another field moved over time.' },
  { type: 'healthcheck', words: 'a health check', meaning: 'An address the hub calls to see it is up.' },
  { type: 'openapi', words: 'an API document', meaning: 'An OpenAPI document, read as a reference.' },
  { type: 'secretRef', words: 'a secret', meaning: 'Where a secret is kept, never its value.' },
]

const BY_TYPE = new Map(KINDS.map((k) => [k.type, k]))

/** A field's kind in words: "a number", "one of a list", "several of a list". */
export function kindWords(def: Pick<FieldDef, 'type' | 'many'>): string {
  if (def.many && def.type === 'enum') return 'several of a list'
  if (def.many && def.type === 'url') return 'links'
  return BY_TYPE.get(def.type)?.words ?? def.type
}

/** Where a field's value comes from: typed or pushed, copied across a relation, counted or added up, or worked out by a formula. */
export type Source = 'typed' | 'mirror' | 'aggregation' | 'calculation'

export function sourceOf(def: FieldDef): Source {
  if (def.aggregation) return 'aggregation'
  if (def.mirror) return 'mirror'
  if (def.calculation !== undefined) return 'calculation'
  return 'typed'
}

/** One step an aggregation can take from a blueprint: what it reaches, and the path that names it. */
export interface Reach {
  path: string
  /** The blueprint at the other end. */
  to: string
  /** The step in words, after "every": "Service that points at it as Pillars". */
  words: string
}

/** Every one-hop step out of a blueprint: the relations it declares, and those of every blueprint that point at it. */
export function reachesFrom(bp: Blueprint, all: Blueprint[], name: BlueprintNamer): Reach[] {
  const out = Object.entries(bp.relations).map(([rel, r]): Reach => ({ path: rel, to: r.target, words: `${name(r.target)} it points at as ${r.title ?? said(rel)}` }))
  const into = all.flatMap((o) =>
    Object.entries(o.relations)
      .filter(([, r]) => r.target === bp.id)
      .map(([rel, r]): Reach => ({ path: `<-${o.id}:${rel}`, to: o.id, words: `${name(o)} that points at it as ${r.title ?? said(rel)}` })),
  )
  return [...out, ...into]
}

/** The blueprint a one-hop path ends on, or null for a longer path or one that names nothing. */
export function reachOf(path: string, bp: Blueprint, all: Blueprint[], name: BlueprintNamer): Reach | null {
  let hops: Hop[]
  try {
    hops = parsePath(path)
  } catch {
    return null
  }
  if (hops.length !== 1) return null
  const [hop] = hops
  const reaches = reachesFrom(bp, all, name)
  const exact = reaches.find((r) => r.path === path)
  if (exact || !hop!.incoming || hop!.from) return exact ?? null
  // `<-relation` takes it from every blueprint: it has words only while one blueprint has such a relation.
  const any = reaches.filter((r) => r.path.startsWith('<-') && r.path.endsWith(`:${hop!.relation}`))
  return any.length === 1 ? any[0]! : null
}

const FN_WORDS: Record<AggregationDef['fn'], string> = { count: 'the count', sum: 'the total', min: 'the lowest', max: 'the highest', avg: 'the average', median: 'the median', p90: 'the 90th percentile', checks: 'what each rule says in' }

/** What an aggregation does in words: "the count of every Service that points at it as Pillars", "the total Cost of every Resource …". */
export function aggregationWords(agg: AggregationDef, bp: Blueprint, all: Blueprint[], name: BlueprintNamer): string {
  const reach = reachOf(agg.relation, bp, all, name)
  const end = reach ? all.find((b) => b.id === reach.to) : undefined
  const over = reach ? `every ${reach.words}` : `what ${agg.relation} reaches`
  const field = agg.field ? (end?.fields[agg.field]?.title ?? said(agg.field)) : null
  const what = `${agg.fn === 'count' || !field ? `${FN_WORDS[agg.fn]} of ${over}` : `${FN_WORDS[agg.fn]} ${field} of ${over}`}${whereWords(agg.where, end)}`
  const window = agg.window ? `, in the last ${agg.window.last}${agg.window.offset ? ` before the last ${agg.window.offset}` : ''}` : ''
  return `${what}${window}${agg.per ? `, per ${agg.per}` : ''}`
}

/** An aggregation's condition after what it reaches: " whose Status is red", or " that meet a condition" when it is more than tests joined by and. */
function whereWords(where: AggregationDef['where'], end: Blueprint | undefined): string {
  if (!where) return ''
  const clauses = clausesOf(where)
  if (!clauses?.length) return ' that meet a condition'
  const parts = clauses.map((c) => {
    const name = c.field.replace(/^\$/, '')
    const def = end?.fields[name]
    return sentence(c, def?.title ?? said(name), c.value, def?.type)
  })
  return ` whose ${parts.join(' and ')}`
}

/** A copied value in words: "the URL on its Repository". A longer path is said as itself. */
export function mirrorWords(spec: string, bp: Blueprint, all: Blueprint[], name: BlueprintNamer): string {
  const { path, field } = splitMirror(spec)
  const reach = reachOf(path, bp, all, name)
  if (!reach || path.startsWith('<-')) return `copied from ${spec}`
  const end = all.find((b) => b.id === reach.to)
  const title = field === 'title' ? 'title' : (end?.fields[field]?.title ?? said(field))
  return `the ${title} on its ${name(reach.to)}`
}

/** How a field reads after its name: its kind, or where its value comes from. */
export function fieldWords(def: FieldDef, bp: Blueprint, all: Blueprint[], name: BlueprintNamer): string {
  if (def.aggregation) return aggregationWords(def.aggregation, bp, all, name)
  if (def.mirror) return mirrorWords(def.mirror, bp, all, name)
  if (def.pivoted) return `the "${def.pivoted.key}" in ${def.pivoted.field}`
  if (def.calculation !== undefined) return `${kindWords(def)}, worked out`
  return kindWords(def)
}

/** The name a new field or relation takes from the words a person typed: "Time to restore (p50)" is `time_to_restore_p50`, kept apart from what is taken. */
export function nameFor(words: string, taken: readonly string[]): string {
  const base = words
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
  if (!base) return ''
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`
}
