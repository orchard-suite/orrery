// The change statement: what one change to a live thing will do, stated
// before it runs, by the tool that will make it. The contract is the platform
// kit's (`change/schema/statement.json`); `change/statement.json` beside this
// file is a copy of it, at the version go.mod requires, and a Go test holds
// the copy to that version byte for byte. This module checks a statement
// against the copy, reads its canonical form for the digest, and says it in
// words. It runs in the browser and in the hub alike; the hub alone hashes.

import STATEMENT_SCHEMA from './change/statement.json' with { type: 'json' }

/** One catalog entity, by its blueprint and key. */
export interface ChangeRef {
  blueprint: string
  key: string
}

export interface ChangeActor {
  kind: 'person' | 'agent' | 'system'
  id: string
  on_behalf_of?: string
}

/** What a change does to one live thing, never the tool's verb. */
export interface ChangeEffect {
  kind: string
  subject: ChangeRef
  path: string
  size?: number
  undo: 'yes' | 'no' | 'partial'
  claim: { from: 'writer' | 'estate' | 'model'; rule?: string; version?: string }
}

/** One part of the change the writer could not name an effect for. */
export interface ChangeUnknown {
  thing?: ChangeRef
  part: string
  why: 'unread' | 'unnamed'
}

/** One change, as the tool that will make it states it. */
export interface ChangeStatement {
  key: string
  writer: { name: string; version: string }
  actor: ChangeActor
  things?: ChangeRef[]
  artifact: { kind: string; digest: string }
  /** Where it runs: `hub`, a job the hub starts, or `asker`, the machine that asked. */
  applier: 'hub' | 'asker'
  effects?: ChangeEffect[]
  unknown?: ChangeUnknown[]
}

/** The member that sends the change events of a run. */
export const CHANGE_SENDER = 'orrery'

/** The four change events a run sends, as the contract names them. */
export const CHANGE_EVENTS = ['change.stated', 'change.routed', 'change.decided', 'change.ended'] as const
export type ChangeEventName = (typeof CHANGE_EVENTS)[number]

/** What every change event carries. `of` names the stated event a later one belongs to. */
interface ChangeHeader<E extends ChangeEventName> {
  event: E
  sender: string
  key: string
  at: string
  of?: { sender: string; key: string }
  digest: string
}

export interface ChangeGrant {
  path?: string
  field?: string
  values: string[]
}

export type ChangeStated = ChangeHeader<'change.stated'> & { statement: ChangeStatement }
export type ChangeRouted = ChangeHeader<'change.routed'> & {
  judge: { name: string; version: string; pack: string }
  route: { to: 'no_one' } | { to: 'people'; grants: ChangeGrant[]; quorum: number }
  reasons: { rule: string }[]
}
export type ChangeDecided = ChangeHeader<'change.decided'> & { by: { kind: 'person'; id: string }; answer: 'yes' | 'no' }
export type ChangeEnded = ChangeHeader<'change.ended'> & {
  outcome: 'ok' | 'failed' | 'refused'
  check: ChangeCheck
  differs?: string[]
}
export type ChangeEvent = ChangeStated | ChangeRouted | ChangeDecided | ChangeEnded

/** What the applier found when it recomputed the statement from the artifact it holds. */
export const CHANGE_CHECKS = ['matched', 'differed', 'unchecked'] as const
export type ChangeCheck = (typeof CHANGE_CHECKS)[number]

/** The top-level fields of a statement, in the contract's order: what an applier may say differed. */
export const STATEMENT_FIELDS = ['key', 'writer', 'actor', 'things', 'artifact', 'applier', 'effects', 'unknown'] as const

/** The run outputs the applier reports its check in. */
export const CHECK_OUTPUT = 'statement_check'
export const DIFFERS_OUTPUT = 'statement_differs'

// The schema, read ----------------------------------------------------------------

/** One node of a JSON Schema, as far as the statement's schema uses it. */
interface Node {
  $ref?: string
  type?: string
  enum?: unknown[]
  const?: unknown
  required?: string[]
  properties?: Record<string, Node>
  additionalProperties?: boolean
  items?: Node
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  anyOf?: Node[]
  not?: Node
  if?: Node
  then?: Node
  $defs?: Record<string, Node>
}

/** The keywords this reading knows. A copy of the schema that uses another is refused as the module loads, never read past. */
const KEYWORDS = new Set(['$schema', 'title', 'description', '$ref', '$defs', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'anyOf', 'not', 'if', 'then'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Each keyword of the schema, checked known, with every pattern compiled once. */
function load(node: unknown, at: string, patterns: Map<string, RegExp>): Node {
  if (!isObject(node)) throw new Error(`change schema: ${at} is not a schema`)
  for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) throw new Error(`change schema: ${at} uses ${k}, which the hub does not read`)
  const n = node as Node
  if (n.pattern !== undefined && !patterns.has(n.pattern)) patterns.set(n.pattern, new RegExp(n.pattern, 'u'))
  for (const [k, child] of Object.entries(n.properties ?? {})) load(child, `${at}.properties.${k}`, patterns)
  for (const [k, child] of Object.entries(n.$defs ?? {})) load(child, `${at}.$defs.${k}`, patterns)
  for (const [i, child] of (n.anyOf ?? []).entries()) load(child, `${at}.anyOf[${i}]`, patterns)
  for (const k of ['items', 'not', 'if', 'then'] as const) if (n[k] !== undefined) load(n[k], `${at}.${k}`, patterns)
  return n
}

const PATTERNS = new Map<string, RegExp>()
const ROOT = load(STATEMENT_SCHEMA, '#', PATTERNS)

function resolve(ref: string): Node {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref)
  const def = m ? ROOT.$defs?.[m[1]!] : undefined
  if (!def) throw new Error(`change schema: ${ref} names no definition`)
  return def
}

const typed: Record<string, (v: unknown) => boolean> = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
const where = (at: string): string => at || 'the statement'

/** The first way the value breaks the node, said at the path it breaks at, or null. */
function breaks(node: Node, v: unknown, at: string): string | null {
  if (node.$ref) {
    const wrong = breaks(resolve(node.$ref), v, at)
    if (wrong) return wrong
  }
  if (node.type && !typed[node.type]?.(v)) return `${where(at)} must be ${node.type === 'integer' ? 'a whole number' : node.type === 'object' ? 'an object' : node.type === 'array' ? 'a list' : `a ${node.type}`}`
  if (node.enum && !node.enum.some((e) => same(e, v))) return `${where(at)} must be one of ${node.enum.map(shown).join(', ')}`
  if ('const' in node && !same(node.const, v)) return `${where(at)} must be ${shown(node.const)}`
  if (typeof v === 'string') {
    const length = [...v].length
    if (node.minLength !== undefined && length < node.minLength) return node.minLength === 1 ? `${where(at)} must not be empty` : `${where(at)} must hold at least ${node.minLength} characters`
    if (node.maxLength !== undefined && length > node.maxLength) return `${where(at)} must hold at most ${node.maxLength} characters`
    if (node.pattern !== undefined && !PATTERNS.get(node.pattern)!.test(v)) return `${where(at)} must match ${node.pattern}`
  }
  if (typeof v === 'number' && node.minimum !== undefined && v < node.minimum) return `${where(at)} must be ${node.minimum} or more`
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) return `${where(at)} must hold at least ${node.minItems}`
    if (node.maxItems !== undefined && v.length > node.maxItems) return `${where(at)} must hold at most ${node.maxItems}`
    if (node.uniqueItems) {
      const seen = new Set<string>()
      for (const [i, item] of v.entries()) {
        const k = canonical(item)
        if (seen.has(k)) return `${at}[${i}] is in the list twice`
        seen.add(k)
      }
    }
    if (node.items) for (const [i, item] of v.entries()) {
      const wrong = breaks(node.items, item, `${at}[${i}]`)
      if (wrong) return wrong
    }
  }
  if (isObject(v)) {
    const field = (k: string) => (at ? `${at}.${k}` : k)
    for (const k of node.required ?? []) if (!(k in v)) return `${field(k)} is required`
    for (const [k, child] of Object.entries(node.properties ?? {})) {
      if (!(k in v)) continue
      const wrong = breaks(child, v[k], field(k))
      if (wrong) return wrong
    }
    if (node.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (node.properties ?? {}))) return `${field(k)} is not part of a change statement`
  }
  if (node.anyOf && !node.anyOf.some((branch) => breaks(branch, v, at) === null)) {
    const needs = node.anyOf.map((b) => b.required?.join(' and ')).filter(Boolean)
    return needs.length === node.anyOf.length ? `${where(at)} must name at least one of: ${needs.join(', or ')}` : `${where(at)} matches none of the forms a statement takes`
  }
  if (node.not && breaks(node.not, v, at) === null) return node.not.required ? `${where(at)} must not hold ${node.not.required.join(' or ')} here` : `${where(at)} is a form a statement may not take`
  if (node.if && node.then && breaks(node.if, v, at) === null) return breaks(node.then, v, at)
  return null
}

/** What is wrong with a value as a change statement, by the platform kit's schema, or null when it is one. */
export function statementIssue(value: unknown): string | null {
  return breaks(ROOT, value, '')
}

/** A value as a statement, or why it is not one: an object, or JSON text of one. */
export function readStatement(value: unknown): { ok: true; statement: ChangeStatement } | { ok: false; error: string } {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return { ok: false, error: 'expected a change statement, as JSON' }
    }
  }
  const wrong = statementIssue(v)
  return wrong ? { ok: false, error: wrong } : { ok: true, statement: v as ChangeStatement }
}

// The digest ----------------------------------------------------------------------

/** Every empty list, empty object, empty string, and null left out, deep; undefined when nothing is left. */
function prune(v: unknown): unknown {
  if (v === null || v === '' || v === undefined) return undefined
  if (Array.isArray(v)) {
    const kept = v.map(prune).filter((x) => x !== undefined)
    return kept.length ? kept : undefined
  }
  if (isObject(v)) {
    const kept = Object.entries(v).flatMap(([k, x]) => {
      const p = prune(x)
      return p === undefined ? [] : [[k, p] as const]
    })
    return kept.length ? Object.fromEntries(kept) : undefined
  }
  return v
}

/** RFC 8785 JSON: keys in UTF-16 order, numbers and strings as ECMAScript writes them. */
function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/**
 * The canonical form the statement's digest is taken over, as the platform
 * kit's digest rule says: RFC 8785 over the value with every empty list,
 * empty object, empty string, and null left out. The digest is
 * `sha256:` and the hex of its SHA-256.
 */
export function canonical(v: unknown): string {
  return jcs(prune(v) ?? null)
}

// In words ------------------------------------------------------------------------

/** Where a change runs, said for whoever approves it. */
export function applierText(applier: ChangeStatement['applier']): string {
  return applier === 'hub' ? 'a job the hub starts' : 'the machine that asked'
}

export const refText = (r: ChangeRef): string => `${r.blueprint} ${r.key}`

const UNDO: Record<ChangeEffect['undo'], string> = { yes: 'the old artifact puts it back', no: 'it cannot be undone', partial: 'the old artifact puts part of it back' }
const CLAIM: Record<ChangeEffect['claim']['from'], string> = { writer: "the writer's own table", estate: "the estate's table", model: "a model's reading of the provider's documents" }

/** One effect in words: what it does, to which thing, by which path, whether it can be undone, and where the claim came from. */
export function effectText(e: ChangeEffect): string {
  const claim = [e.claim.rule && `rule ${e.claim.rule}`, e.claim.version].filter(Boolean).join(', ')
  return `${e.kind} ${refText(e.subject)}${e.size !== undefined ? ` (${e.size})` : ''}, ${e.path}; ${UNDO[e.undo]}; claimed by ${CLAIM[e.claim.from]}${claim ? ` (${claim})` : ''}`
}

/** One part the writer could not name an effect for, in words. */
export function unknownText(u: ChangeUnknown): string {
  return `${u.thing ? `${refText(u.thing)}: ` : ''}${u.part}, ${u.why === 'unread' ? 'which the writer could not read' : 'which the writer read and has no effect for'}`
}

/** Who asks for the change, in words. */
export function actorText(a: ChangeActor): string {
  return a.on_behalf_of ? `${a.kind} ${a.id}, for ${a.on_behalf_of}` : `${a.kind} ${a.id}`
}

/** The whole statement as plain lines, for a notice: what runs where, each effect, and each part nobody could name. */
export function statementLines(s: ChangeStatement): string[] {
  const lines = [`Change ${s.key}, written by ${s.writer.name} ${s.writer.version} for ${actorText(s.actor)}.`, `It runs on ${applierText(s.applier)}, from the ${s.artifact.kind} ${s.artifact.digest}.`]
  if (s.things?.length) lines.push(`It touches ${s.things.map(refText).join(', ')}.`)
  const effects = s.effects ?? []
  lines.push(effects.length ? 'Effects:' : 'Effects: none stated.')
  for (const e of effects) lines.push(`- ${effectText(e)}`)
  const unknown = s.unknown ?? []
  if (unknown.length) {
    lines.push('Parts with no effect named:')
    for (const u of unknown) lines.push(`- ${unknownText(u)}`)
  }
  return lines
}
